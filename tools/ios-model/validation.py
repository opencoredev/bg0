"""Fail-closed validation for the float32 export, before quantization."""
import math
from pathlib import Path

# The pinned 384/512px exports measured <7.1e-5 maximum absolute logit error.
# 1e-3 allows FP32 accumulation variance while retaining the existing patched
# PyTorch model tolerance. Sigmoid's derivative is at most 1/4, so the matching
# probability-space bound is 2.5e-4 (about 0.064 of one 8-bit alpha level).
# These are numerical equivalence limits, not segmentation-quality guarantees.
MAX_LOGIT_ERROR = 1e-3
MAX_ALPHA_ERROR = 2.5e-4


def publish_validated_export(
    candidate: Path, destination: Path, logit_error: float, alpha_error: float
) -> None:
    for label, error, limit in (
        ('logit', logit_error, MAX_LOGIT_ERROR),
        ('alpha', alpha_error, MAX_ALPHA_ERROR),
    ):
        if not math.isfinite(error) or error < 0 or error > limit:
            raise ValueError(
                f'ONNX export rejected: maximum {label} error {error!r} '
                f'exceeds finite non-negative tolerance {limit}'
            )
    # Candidate and destination are on the same filesystem. Failed validation
    # never overwrites a previous artifact or creates a new final output.
    candidate.replace(destination)
