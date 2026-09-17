"""Reproduce the validated 384/512px dynamic-uint8 BiRefNet-lite experiments.

No calibration photos are embedded. Dynamic quantization computes activation
ranges per inference. Quality has only been checked on two public fixtures.
"""
from pathlib import Path
import sys
import onnx
import onnxruntime as rt
from onnxruntime.quantization import quantize_dynamic, QuantType

size = 512
assert size in (384, 512), '256px fully quantized export failed quality checks'
root = Path(__file__).resolve().parent
target = root / 'output'
target.mkdir(exist_ok=True)
model = target / f'int8-full-{size}.onnx'
quantize_dynamic(str(root / f'grid-{size}-fp32.onnx'), str(model),
                 weight_type=QuantType.QUInt8,
                 op_types_to_quantize=['MatMul', 'Conv'], per_channel=False)
onnx.checker.check_model(str(model))
options = rt.SessionOptions()
options.graph_optimization_level = rt.GraphOptimizationLevel.ORT_DISABLE_ALL
options.intra_op_num_threads = 1
options.enable_cpu_mem_arena = False
options.enable_mem_pattern = False
options.optimized_model_filepath = str(target / f'int8-full-{size}.ort')
options.add_session_config_entry('session.save_model_format', 'ORT')
rt.InferenceSession(str(model), options, providers=['CPUExecutionProvider'])
print('Packaged validated resolution', size)
