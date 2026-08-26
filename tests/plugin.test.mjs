import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { apply } from '../sandbox-same-mode.js'
import { _internals as pathViewer } from '../path-viewer.js'

const ESCALATION_MODES = ['workspace-write', 'danger-full-access']

function sandboxProperties() {
  return {
    sandbox_permissions: { type: 'string', enum: [...ESCALATION_MODES] },
    justification: { type: 'string' },
  }
}

function definition(name, properties, execute = async args => args) {
  return { name, parameters: { properties }, execute }
}

function harness(definitions, mode = 'workspace-write') {
  let change
  let dispose
  const registeredOutsideGlobalView = []
  const policy = {
    resolve(request) {
      assert.ok(request)
      return { mode, workspaceRoot: '/workspace' }
    },
  }
  const tools = {
    schemas: () => definitions.map(({ name, parameters }) => ({ name, parameters })),
    get: name => definitions.find(definition => definition.name === name),
    register(definition) {
      registeredOutsideGlobalView.push(definition)
      change?.()
      return () => {
        const index = registeredOutsideGlobalView.indexOf(definition)
        if (index >= 0) registeredOutsideGlobalView.splice(index, 1)
      }
    },
  }
  const originalRegister = tools.register
  const ctx = {
    tools,
    get: key => key === 'sandboxPolicy' ? policy : undefined,
    on: (event, listener) => {
      assert.equal(event, 'tools/change')
      change = listener
      return () => { if (change === listener) change = undefined }
    },
    effect: setup => {
      dispose = setup()
      return () => dispose?.()
    },
  }
  apply(ctx)
  return {
    dispose: () => dispose?.(),
    registerScoped: definition => tools.register(definition),
    tools,
    originalRegister,
  }
}

test('same-mode sandbox request is removed before the built-in tool executes', async () => {
  const calls = []
  const tool = definition('bash', sandboxProperties(), async args => {
    calls.push(args)
    return args
  })
  const runtime = harness([tool])
  const args = Object.freeze({
    command: 'pwd',
    sandbox_permissions: 'workspace-write',
    justification: 'the command stays within the current workspace',
  })

  const result = await tool.execute(args, { agent: { session: { id: 'session-1' } } })

  assert.deepEqual(result, { command: 'pwd' })
  assert.deepEqual(calls, [{ command: 'pwd' }])
  runtime.dispose()
})

test('a lower-mode retry is removed when danger-full-access is already effective', async () => {
  const calls = []
  const tool = definition('write', sandboxProperties(), async args => {
    calls.push(args)
    return args
  })
  const runtime = harness([tool], 'danger-full-access')
  const args = Object.freeze({
    file_path: '/home/wang/codes/StickyProxy/plugin/internal/state/store.go',
    content: 'x',
    sandbox_permissions: 'workspace-write',
    justification: 'write the requested plugin fix outside the workspace',
  })

  const result = await tool.execute(args, { agent: { session: { id: 'session-1' } } })

  assert.deepEqual(result, {
    file_path: '/home/wang/codes/StickyProxy/plugin/internal/state/store.go',
    content: 'x',
  })
  assert.deepEqual(calls, [result])
  runtime.dispose()
})

test('a wider request remains on the built-in approval path', async () => {
  const calls = []
  const tool = definition('bash', sandboxProperties(), async args => {
    calls.push(args)
    return args
  })
  const runtime = harness([tool], 'workspace-write')
  const args = {
    command: 'touch outside',
    sandbox_permissions: 'danger-full-access',
    justification: 'the command needs the wider mode',
  }

  const result = await tool.execute(args, { agent: { session: { id: 'session-1' } } })

  assert.strictEqual(result, args)
  assert.deepEqual(calls, [args])
  runtime.dispose()
})

test('malformed same-mode pairs remain visible to built-in validation', async () => {
  const tool = definition('write', sandboxProperties())
  const runtime = harness([tool])
  const args = { file_path: 'a.txt', sandbox_permissions: 'workspace-write' }

  const result = await tool.execute(args, { agent: { session: { id: 'session-1' } } })

  assert.strictEqual(result, args)
  runtime.dispose()
})

test('an unadvertised same-mode value remains visible to the built-in schema validator', async () => {
  const tool = definition('bash', sandboxProperties())
  const runtime = harness([tool], 'read-only')
  const args = {
    command: 'pwd',
    sandbox_permissions: 'read-only',
    justification: 'this is not an advertised escalation target',
  }

  const result = await tool.execute(args, { agent: { session: { id: 'session-1' } } })

  assert.strictEqual(result, args)
  runtime.dispose()
})

test('only tools with an enumerated sandbox escalation field are wrapped', async () => {
  const custom = definition('custom', { value: {} })
  const unbounded = definition('unbounded', { sandbox_permissions: {}, justification: {} })
  const customOriginal = custom.execute
  const unboundedOriginal = unbounded.execute
  const runtime = harness([custom, unbounded])

  assert.strictEqual(custom.execute, customOriginal)
  assert.strictEqual(unbounded.execute, unboundedOriginal)
  runtime.dispose()
})

test('a scoped tool registered after plugin startup is wrapped and cleanup restores it', async () => {
  const runtime = harness([])
  const calls = []
  const tool = definition('edit', sandboxProperties(), async args => {
    calls.push(args)
    return args
  })
  const original = tool.execute

  runtime.registerScoped(tool)
  assert.notStrictEqual(tool.execute, original)

  await tool.execute({
    file_path: 'a.txt',
    sandbox_permissions: 'workspace-write',
    justification: 'the edit stays within the current workspace',
  }, { agent: { session: { id: 'session-1' } } })
  assert.deepEqual(calls, [{ file_path: 'a.txt' }])

  runtime.dispose()
  assert.strictEqual(tool.execute, original)
  assert.strictEqual(runtime.tools.register, runtime.originalRegister)
})

test('path viewer intercepts URL-based host open requests from the web API client', async () => {
  const opened = []
  const originalCalls = []
  const context = {
    URL,
    Response,
    window: {
      fetch: (...args) => {
        originalCalls.push(args)
        return Promise.resolve(new Response('original'))
      },
      open: (...args) => {
        opened.push(args)
        return {}
      },
    },
  }
  vm.runInNewContext(pathViewer.interceptionScript(['host.openPath']), context)

  const response = await context.window.fetch(new URL('http://127.0.0.1:3080/api/host.openPath'), {
    method: 'POST',
    body: JSON.stringify({
      type: 'client-request', rpcId: 'path-viewer-url', method: 'host.openPath', payload: { path: '/tmp/example.txt' },
    }),
  })

  assert.deepEqual(opened, [['/view?path=%2Ftmp%2Fexample.txt', '_blank']])
  assert.deepEqual(originalCalls, [])
  assert.deepEqual(await response.json(), {
    type: 'server-response', rpcId: 'path-viewer-url', result: { ok: true, value: { opened: true } },
  })
})

test('path viewer pages use the responsive code-viewer shell', () => {
  const html = pathViewer.page('Example', '<p>content</p>')

  assert.match(html, /<main class="shell"><p>content<\/p><\/main>/)
  assert.match(html, /SOURCE FILE|DIRECTORY|CODE VIEWER|\.shell\{max-width:1600px/)
  assert.match(html, /@media\(max-width:680px\)/)
})

test('path viewer applies syntax highlighting only to known source types', () => {
  const highlighted = pathViewer.highlightCode('const answer = "ok"\n// note', '/tmp/example.js')
  const plain = pathViewer.highlightCode('<b>safe</b>', '/tmp/example.txt')

  assert.match(highlighted, /hljs-keyword/)
  assert.match(highlighted, /hljs-string/)
  assert.match(highlighted, /hljs-comment/)
  assert.equal(plain, '&lt;b&gt;safe&lt;/b&gt;')
})
