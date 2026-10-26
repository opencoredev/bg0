import { canUseOnnxWebGpu, shouldUseSingleThreadedWasm } from './runtime'

export type RemovalModel = 'birefnet' | 'birefnet-lite'
export type ExecutionProvider = 'webgpu' | 'wasm'

/**
 * Which weights to download. `auto` picks by device; `lite` and `full` pin
 * the choice, for example to keep the first download small on a slow network.
 */
export const MODEL_TIERS = ['auto', 'lite', 'full'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export interface ModelDefinition {
  name: RemovalModel
  id: string
  revision: string
  bytes: number
  inputSize: number
}

export const LITE_MODEL: ModelDefinition = {
  name: 'birefnet-lite',
  id: 'studioludens/birefnet-lite-512',
  revision: '4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7',
  bytes: 98_484_532,
  inputSize: 512,
}

// Full Swin-L BiRefNet weights, exported at 512px with empty ScatterND
// operations removed for WebGPU. The unpatched 1024px export exceeds browser
// shader binding limits even on otherwise capable GPUs.
export const FULL_MODEL: ModelDefinition = {
  name: 'birefnet',
  id: 'naddy24/birefnet-512-webgpu',
  revision: 'ca02a86c094927479e2be583abe87f8ea73fcfda',
  bytes: 473_435_223,
  inputSize: 512,
}

/** Download size of each pinned tier's weights, in bytes. */
export const MODEL_TIER_BYTES = {
  lite: LITE_MODEL.bytes,
  full: FULL_MODEL.bytes,
} as const satisfies Record<Exclude<ModelTier, 'auto'>, number>

export interface EngineChoice {
  definition: ModelDefinition
  provider: ExecutionProvider
}

interface AdapterCapabilities {
  features: { has: (feature: string) => boolean }
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number }
  isFallbackAdapter?: boolean
}

interface HardwareNavigator {
  userAgent: string
  deviceMemory?: number
  hardwareConcurrency?: number
  maxTouchPoints?: number
  gpu?: { requestAdapter: () => Promise<AdapterCapabilities | null> }
}

export function modelUrl(model: ModelDefinition): string {
  return `https://huggingface.co/${model.id}/resolve/${model.revision}/onnx/model_fp16.onnx`
}

export function engineKey(choice: EngineChoice): string {
  return `${choice.definition.id}:${choice.definition.revision}:${choice.provider}`
}

/** A GPU process that never answers must not hold up the CPU fallback. */
export const ADAPTER_TIMEOUT_MS = 5_000

function requestAdapterWithin(
  gpu: NonNullable<HardwareNavigator['gpu']>,
  timeoutMs: number,
): Promise<AdapterCapabilities | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    gpu.requestAdapter(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Missing RAM hints are common; only a reported low-memory device opts out. */
export async function detectEngineChoices(
  hardware: HardwareNavigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as HardwareNavigator),
  options: { adapterTimeoutMs?: number } = {},
): Promise<EngineChoice[]> {
  const choices: EngineChoice[] = []
  const memory = hardware?.deviceMemory
  const lowMemory = Boolean(memory && memory < 4)
  if (hardware && canUseOnnxWebGpu(hardware.userAgent, Boolean(hardware.gpu))) {
    try {
      const adapter = hardware.gpu
        ? await requestAdapterWithin(
            hardware.gpu,
            options.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS,
          )
        : null
      if (
        adapter &&
        !adapter.isFallbackAdapter &&
        adapter.features.has('shader-f16')
      ) {
        // These are admission heuristics, not a VRAM measurement. Runtime
        // failures still fall back. Do not gate on CPU count or GPU branding.
        if (
          !lowMemory &&
          adapter.limits.maxBufferSize >= 256 * 1024 * 1024 &&
          adapter.limits.maxStorageBufferBindingSize >= 128 * 1024 * 1024
        ) {
          choices.push({ definition: FULL_MODEL, provider: 'webgpu' })
        }
        choices.push({ definition: LITE_MODEL, provider: 'webgpu' })
      }
    } catch {
      // An exposed API may still be disabled by browser policy or the driver.
    }
  }
  // CPU-only desktops can still afford the full weights. iOS has a tighter
  // tab budget and already requires the single-threaded compatibility path.
  // Do not retry the large model on CPU after a GPU failure: use lite instead.
  if (
    choices.length === 0 &&
    hardware &&
    !lowMemory &&
    (hardware.hardwareConcurrency ?? 0) >= 4 &&
    !shouldUseSingleThreadedWasm(hardware.userAgent, hardware.maxTouchPoints)
  ) {
    choices.push({ definition: FULL_MODEL, provider: 'wasm' })
  }
  choices.push({ definition: LITE_MODEL, provider: 'wasm' })
  return choices
}

/**
 * Narrow detected choices to a pinned tier. Pinning full tries the full model
 * even where detection declined it, on WebGPU when detection found a usable
 * GPU, and keeps lite as the fallback so a failure still produces a result.
 */
export function choicesForTier(
  choices: EngineChoice[],
  tier: ModelTier,
): EngineChoice[] {
  switch (tier) {
    case 'auto':
      return choices
    case 'lite':
      return choices.filter((choice) => choice.definition.name !== 'birefnet')
    case 'full': {
      const full = choices.filter(
        (choice) => choice.definition.name === 'birefnet',
      )
      const lite = choices.filter(
        (choice) => choice.definition.name !== 'birefnet',
      )
      if (full.length === 0) {
        const gpu = lite.some((choice) => choice.provider === 'webgpu')
        full.push({ definition: FULL_MODEL, provider: gpu ? 'webgpu' : 'wasm' })
      }
      return [...full, ...lite]
    }
    default: {
      const _exhaustive: never = tier
      return _exhaustive
    }
  }
}
