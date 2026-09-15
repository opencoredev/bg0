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
  base: InferenceMask
  signal?: AbortSignal
  onRefining: () => void
  infer: (source: RawImage) => Promise<InferenceMask>
}

export async function createMaskRefinement({
  quality,
  source,
  base,
  signal,
  onRefining,
  infer,
}: RefinementOptions): Promise<MaskRefinement | undefined> {
  if (quality !== 'quality') return undefined
  const crop = findRefinementCrop(
    base.alpha,
    base.maskWidth,
    base.maskHeight,
    source.width,
    source.height,
  )
  if (!crop) return undefined

  throwIfCancelled(signal)
  onRefining()
  try {
    const croppedSource = await source
      .clone()
      .crop([crop.left, crop.top, crop.right, crop.bottom])
    const refined = await infer(croppedSource)
    throwIfCancelled(signal)
    if (!refined.inspection.valid || !refined.inspection.hasForegroundSignal) {
      return undefined
    }
    return {
      mask: refined.alpha,
      maskWidth: refined.maskWidth,
      maskHeight: refined.maskHeight,
      crop,
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
