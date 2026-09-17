# Adapted from CoderViking/BiRefNet-lite export; see docs/ios-model.md.
#!/usr/bin/env python
"""Browser-tuned ONNX export of BiRefNet_lite (ZhengPeng7/BiRefNet_lite, MIT).

Why a custom export exists: the community export (onnx-community/BiRefNet_lite-ONNX)
is a dynamic-shape trace whose deformable convolutions decompose into
GatherND/ScatterND/Clip chains. Those ops fall back to CPU on the ONNX Runtime
Web WebGPU EP and materialize im2col tensors of hundreds of MB, which overflows
the 32-bit wasm heap at 1024x1024 (OrtRun std::bad_alloc on every EP).

This export:
  * pins the source checkpoint by commit sha and loads it with
    transformers' trust_remote_code path (the model code ships in the repo);
  * replaces DeformableConv2d.forward with a numerically identical per-tap
    GridSample decomposition (one bilinear GridSample + 1x1 Conv per kernel
    tap, accumulated) - peak extra memory is one [1,C,H,W] tensor per tap
    instead of one [1,C,K,H,W] im2col blob, and the graph uses only ops the
    WebGPU EP implements natively (no GatherND, no ScatterND, no Clip);
  * traces with a static input shape (TorchScript exporter, opset 17, fp32,
    constant folding) so all Shape/Where dynamism folds away;
  * validates the patched module against torchvision.ops.deform_conv2d and the
    final ONNX against the unpatched PyTorch reference.

Usage: python export_birefnet_lite.py [--size 1024] [--out birefnet_lite.onnx]
"""
import argparse
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from validation import publish_validated_export

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REPO = str(__import__('pathlib').Path(__file__).resolve().parent / 'source-checkpoint')
REVISION = '7838f1c3472f827cd8ce13ab5ccc2ce48077360f'  # pinned 2026-07-18


def grid_sample_deform_forward(self, x):
    """Drop-in for DeformableConv2d.forward (birefnet.py) built on GridSample.

    Equivalent to torchvision.ops.deform_conv2d(input, offset, weight, bias,
    stride=1, padding=p, mask=modulator): for kernel tap k at (i, j) the op
    samples x at (y + i - p + dy_k, x + j - p + dx_k) bilinearly with zero
    padding, scales by the modulation mask, and accumulates W[:, :, i, j] as a
    1x1 conv. Offsets are interleaved (dy, dx) per tap, row-major over the
    kernel, matching torchvision's layout.
    """
    offset = self.offset_conv(x)                       # [B, 2K, H, W]
    modulator = 2.0 * torch.sigmoid(self.modulator_conv(x))  # [B, K, H, W]
    B, C, H, W = x.shape
    kh, kw = self.regular_conv.kernel_size
    pad = self.padding
    weight = self.regular_conv.weight                  # [Cout, Cin, kh, kw]

    ys = torch.arange(H, dtype=x.dtype, device=x.device)
    xs = torch.arange(W, dtype=x.dtype, device=x.device)
    base_y, base_x = torch.meshgrid(ys, xs, indexing='ij')  # [H, W] constants
    # pre-normalized base grids (grid_sample align_corners=False convention);
    # keeping the per-tap shift on the dynamic offset lets constant folding
    # share ONE [H, W] grid pair per resolution instead of one per kernel tap
    norm_y = (2 * base_y + 1) / H - 1
    norm_x = (2 * base_x + 1) / W - 1

    out = None
    for k in range(kh * kw):
        i, j = divmod(k, kw)
        py = norm_y + (offset[:, 2 * k] + (i - pad)) * (2.0 / H)   # [B, H, W]
        px = norm_x + (offset[:, 2 * k + 1] + (j - pad)) * (2.0 / W)
        grid = torch.stack([px, py], dim=-1)
        sampled = F.grid_sample(x, grid, mode='bilinear', padding_mode='zeros',
                                align_corners=False)
        sampled = sampled * modulator[:, k:k + 1]
        contrib = F.conv2d(sampled, weight[:, :, i, j].unsqueeze(-1).unsqueeze(-1))
        out = contrib if out is None else out + contrib
    if self.regular_conv.bias is not None:
        out = out + self.regular_conv.bias.view(1, -1, 1, 1)
    return out


def verify_deform_patch(deform_cls):
    """Random-weight equivalence check: patched forward vs torchvision op."""
    from torchvision.ops import deform_conv2d
    torch.manual_seed(0)
    worst = 0.0
    for ksize, pad in [(1, 0), (3, 1), (7, 3)]:
        m = deform_cls(8, 16, kernel_size=ksize, padding=pad, bias=False)
        for p in m.parameters():  # zero-init offsets would hide layout bugs
            nn.init.normal_(p, std=0.3)
        x = torch.randn(1, 8, 20, 24)
        with torch.no_grad():
            offset = m.offset_conv(x)
            modulator = 2.0 * torch.sigmoid(m.modulator_conv(x))
            ref = deform_conv2d(x, offset, m.regular_conv.weight,
                                m.regular_conv.bias, padding=pad,
                                mask=modulator, stride=m.stride)
            got = grid_sample_deform_forward(m, x)
        worst = max(worst, (ref - got).abs().max().item())
    return worst


class LogitsWrapper(nn.Module):
    """BiRefNet eval-forward returns a list of multi-scale preds; the last one
    is the full-resolution logits map the demo pipeline consumes."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, input_image):
        return self.net(input_image)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--out', default='birefnet_lite.onnx')
    args = ap.parse_args()

    destination = Path(args.out).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Only publish a complete, validated artifact. Failed exports leave an
    # existing output untouched and discard all temporary conversion files.
    with TemporaryDirectory(prefix='.bg0-export-', dir=destination.parent) as directory:
        candidate = Path(directory) / destination.name
        args.out = str(candidate)
        logit_error, alpha_error = export_candidate(args)
        publish_validated_export(candidate, destination, logit_error, alpha_error)


def export_candidate(args):
    from transformers import AutoModelForImageSegmentation
    torch.set_num_threads(4)
    torch.set_grad_enabled(False)
    print("Loading reviewed local BiRefNet weights", flush=True)
    model = AutoModelForImageSegmentation.from_pretrained(
        REPO, local_files_only=True, trust_remote_code=True)
    model.eval().float()
    print("Loaded; validating export", flush=True)
    birefnet_mod = sys.modules[type(model).__module__]

    # reference logits from the unpatched model (torchvision deform_conv2d)
    torch.manual_seed(1)
    probe = torch.rand(1, 3, args.size, args.size)
    ref_logits = LogitsWrapper(model)(probe)

    deform_err = verify_deform_patch(birefnet_mod.DeformableConv2d)
    print(f'deform patch vs torchvision: max abs dev {deform_err:.3e}')
    assert deform_err < 1e-4, 'GridSample decomposition diverges from torchvision'

    birefnet_mod.DeformableConv2d.forward = grid_sample_deform_forward
    patched_logits = LogitsWrapper(model)(probe)
    patch_err = (ref_logits - patched_logits).abs().max().item()
    print(f'patched model vs reference: max abs logits dev {patch_err:.3e}')
    assert patch_err < 1e-3

    print("Exporting graph", flush=True)
    torch.onnx.export(
        LogitsWrapper(model),
        (probe,),
        args.out,
        input_names=['input_image'],
        output_names=['output_image'],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )

    # The TorchScript trace leaves the (all-constant, static-shape) Swin
    # attention-mask construction as live ScatterND/Where/Shape chains;
    # onnxslim folds them into initializers.
    # FusionGemm is skipped so the shared (deduped) MatMul weights are not
    # re-split into per-call-site transposed Gemm copies.
    print("Folding static operations", flush=True)
    import onnxslim
    onnxslim.slim(args.out, output_model=args.out,
                  skip_fusion_patterns=['FusionGemm', 'FusionGemmMul', 'FusionGemmAdd'])

    # The backbone is traced twice (multi-scale 'cat' input), and the
    # TorchScript exporter emits one initializer per call site - every Swin
    # weight lands in the file twice (+116 MB). Dedupe by content hash.
    import hashlib
    import onnx
    m = onnx.load(args.out)
    canonical, rename = {}, {}
    keep = []
    for init in m.graph.initializer:
        arr = onnx.numpy_helper.to_array(init)
        h = (str(arr.dtype), arr.shape,
             hashlib.sha256(arr.tobytes()).hexdigest())
        if h in canonical:
            rename[init.name] = canonical[h]
        else:
            canonical[h] = init.name
            keep.append(init)
    del m.graph.initializer[:]
    m.graph.initializer.extend(keep)
    for node in m.graph.node:
        for idx, name in enumerate(node.input):
            if name in rename:
                node.input[idx] = rename[name]
    print(f'deduped {len(rename)} duplicate initializers')
    onnx.save(m, args.out)

    import onnx
    from collections import Counter
    m = onnx.load(args.out, load_external_data=False)
    ops = Counter(n.op_type for n in m.graph.node)
    print('ops:', sorted(ops.items(), key=lambda kv: -kv[1]))
    for banned in ('GatherND', 'ScatterND', 'Clip'):
        assert banned not in ops, f'{banned} in graph - not browser-clean'

    print('Validating native ONNX', flush=True)
    import onnxruntime as ort_rt
    sess = ort_rt.InferenceSession(args.out, providers=['CPUExecutionProvider'])
    onnx_logits = sess.run(None, {'input_image': probe.numpy()})[0]
    reference = ref_logits.numpy()
    if reference.shape != onnx_logits.shape:
        raise ValueError('ONNX output shape differs from the PyTorch reference')
    if not np.isfinite(reference).all() or not np.isfinite(onnx_logits).all():
        raise ValueError('Non-finite values in export validation')
    onnx_err = np.abs(reference - onnx_logits).max()
    alpha_err = np.abs(torch.sigmoid(ref_logits).numpy()
                       - 1 / (1 + np.exp(-onnx_logits))).max()
    print(f'onnx vs torch reference: max abs logits dev {onnx_err:.3e}, '
          f'max sigmoid dev {alpha_err:.3e}')
    return float(onnx_err), float(alpha_err)


if __name__ == '__main__':
    main()
