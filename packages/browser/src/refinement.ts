import type { RawImage } from '@huggingface/transformers'
import { BackgroundRemovalError } from './errors'
import {
  findRefinementCrop,
  type MaskInspection,
  type MaskRefinement,
} from './image'

export interface InferenceMask {
  alpha: Float32Array
  maskWidth: number
  maskHeight: number
  inspection: MaskInspection
}

interface RefinementOptions {
  quality: 'fast' | 'quality'
  source: RawImage
  highResSource?: RawImage
  outputWidth: number
  outputHeight: number
  base: InferenceMask
  signal?: AbortSignal
  onRefining: () => void
  infer: (source: RawImage) => Promise<InferenceMask>
}

export async function createMaskRefinement({
  quality,
  source,
  highResSource,
  outputWidth,
  outputHeight,
  base,
  signal,
  onRefining,
  infer,
}: RefinementOptions): Promise<MaskRefinement | undefined> {
  if (quality !== 'quality') return undefined
  const imageSource = highResSource ?? source
  const crop = findRefinementCrop(
    base.alpha,
    base.maskWidth,
    base.maskHeight,
    imageSource.width,
    imageSource.height,
  )
  if (!crop) return undefined

  throwIfCancelled(signal)
  onRefining()
  try {
    const croppedSource = await imageSource
      .clone()
      .crop([crop.left, crop.top, crop.right - 1, crop.bottom - 1])
    const refined = await infer(croppedSource)
    throwIfCancelled(signal)
    if (!refined.inspection.valid || !refined.inspection.hasForegroundSignal) {
      return undefined
    }
    return {
      mask: refined.alpha,
      maskWidth: refined.maskWidth,
      maskHeight: refined.maskHeight,
      crop: {
        left: Math.floor((crop.left * outputWidth) / imageSource.width),
        top: Math.floor((crop.top * outputHeight) / imageSource.height),
        right: Math.ceil((crop.right * outputWidth) / imageSource.width),
        bottom: Math.ceil((crop.bottom * outputHeight) / imageSource.height),
      },
    }
  } catch {
    // Refinement is optional. Preserve the successful base mask unless the
    // caller cancelled while the second pass was running.
    throwIfCancelled(signal)
    return undefined
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
  }
}
