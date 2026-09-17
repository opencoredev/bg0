import { canUseOnnxWebGpu, shouldUseSingleThreadedWasm } from './runtime'

export type RemovalModel = 'birefnet' | 'birefnet-lite'
export type ExecutionProvider = 'webgpu' | 'wasm'

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

/** Missing RAM hints are common; only a reported low-memory device opts out. */
export async function detectEngineChoices(
  hardware: HardwareNavigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as HardwareNavigator),
): Promise<EngineChoice[]> {
  const choices: EngineChoice[] = []
  const memory = hardware?.deviceMemory
  const lowMemory = Boolean(memory && memory < 4)
  if (hardware && canUseOnnxWebGpu(hardware.userAgent, Boolean(hardware.gpu))) {
    try {
      const adapter = await hardware.gpu?.requestAdapter()
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
