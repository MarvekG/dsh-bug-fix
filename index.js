const SANDBOX_PERMISSION = 'sandbox_permissions'
const JUSTIFICATION = 'justification'
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Treat a valid request for the call's already-effective sandbox mode as a
 * duplicate declaration. Wider requests and malformed/unknown pairs stay on
 * the built-in validation and approval path.
 */
export const name = 'dsh-bug-fix'

/** The tool registry must exist before definitions can be wrapped. */
export const inject = ['tools']

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function escalationModes(definition) {
  const property = definition?.parameters?.properties?.[SANDBOX_PERMISSION]
  if (!isRecord(property) || !Array.isArray(property.enum)) return undefined
  if (!property.enum.every(mode => typeof mode === 'string')) return undefined
  return property.enum
}

function sameModeArguments(ctx, args, exec, modes) {
  if (!isRecord(args)) return args

  const requestedMode = args[SANDBOX_PERMISSION]
  const justification = args[JUSTIFICATION]
  // Retain the original schema's enum check and the built-in pairing/non-empty
  // validation. Only an advertised, complete same-mode request is a no-op.
  if (typeof requestedMode !== 'string' || !modes.includes(requestedMode)
    || typeof justification !== 'string' || justification.trim().length === 0) {
    return args
  }

  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined || typeof policy.resolve !== 'function') return args

  const request = exec?.agent === undefined ? {} : { session: exec.agent.session }
  const effectiveMode = policy.resolve(request).mode
  if (requestedMode !== effectiveMode) return args

  const normalized = { ...args }
  delete normalized[SANDBOX_PERMISSION]
  delete normalized[JUSTIFICATION]
  return normalized
}

/** Wrap one sandbox-escalating definition once and remember its original body. */
function patchDefinition(ctx, records, definition) {
  if (definition === undefined || records.has(definition)) return
  const modes = escalationModes(definition)
  if (modes === undefined) return

  const original = definition.execute
  if (typeof original !== 'function') {
    throw new Error(`dsh-bug-fix: tool "${definition.name}" has no execute function`)
  }

  const wrapped = async function executeWithSameModeCompatibility(args, exec) {
    return original.call(this, sameModeArguments(ctx, args, exec, modes), exec)
  }
  records.set(definition, { original, wrapped })
  definition.execute = wrapped
}

/** Return Cordis's backing service when this is a traceable service proxy. */
function rawService(service) {
  return service?.[CORDIS_ORIGINAL] ?? service
}

/**
 * Install the compatibility wrapper on every already-global definition and on
 * every definition registered later. Intercepting `tools.register()` is needed
 * for DSH Web: its agent presets register bash/pwsh/write/edit in scoped layers,
 * which an unscoped `tools.schemas()` scan cannot see.
 */
export function apply(ctx) {
  const records = new Map()
  const tools = rawService(ctx.tools)
  const originalRegister = tools?.register
  const priorRegister = tools === undefined ? undefined : Object.getOwnPropertyDescriptor(tools, 'register')

  const patchVisibleGlobalDefinitions = () => {
    for (const schema of ctx.tools.schemas()) {
      patchDefinition(ctx, records, ctx.tools.get(schema.name))
    }
  }

  let wrappedRegister
  if (typeof originalRegister === 'function') {
    wrappedRegister = function registerWithSameModeCompatibility(definition, ...rest) {
      patchDefinition(ctx, records, definition)
      return originalRegister.call(this, definition, ...rest)
    }
    tools.register = wrappedRegister
  }

  patchVisibleGlobalDefinitions()
  ctx.on('tools/change', patchVisibleGlobalDefinitions)
  ctx.effect(() => () => {
    if (wrappedRegister !== undefined && tools.register === wrappedRegister) {
      if (priorRegister === undefined) delete tools.register
      else Object.defineProperty(tools, 'register', priorRegister)
    }
    for (const [definition, record] of records) {
      if (definition.execute === record.wrapped) definition.execute = record.original
    }
    records.clear()
  }, 'dsh-bug-fix: restore tool definitions')
}
