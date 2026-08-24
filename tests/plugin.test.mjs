import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../sandbox-same-mode.js'

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
