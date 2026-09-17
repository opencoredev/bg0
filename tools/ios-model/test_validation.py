"""Dependency-free export gate regressions: python3 -m unittest discover here."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from validation import MAX_ALPHA_ERROR, MAX_LOGIT_ERROR, publish_validated_export


class ExportValidationTests(unittest.TestCase):
    def test_known_good_and_boundary_errors_publish(self):
        for errors in ((6.962e-5, 9.459e-10), (7.057e-5, 6.894e-10),
                       (MAX_LOGIT_ERROR, MAX_ALPHA_ERROR)):
            with self.subTest(errors=errors), TemporaryDirectory() as directory:
                root = Path(directory)
                candidate, output = root / 'candidate.onnx', root / 'output.onnx'
                candidate.write_bytes(b'validated model')
                output.write_bytes(b'previous model')
                publish_validated_export(candidate, output, *errors)
                self.assertEqual(output.read_bytes(), b'validated model')
                self.assertFalse(candidate.exists())

    def test_each_bad_metric_blocks_publication_and_preserves_existing_output(self):
        bad_metrics = (
            (10.0, 0.499955),
            (MAX_LOGIT_ERROR * 1.01, 0.0),
            (0.0, MAX_ALPHA_ERROR * 1.01),
            (float('nan'), 0.0), (0.0, float('nan')),
            (float('inf'), 0.0), (0.0, float('inf')),
            (-1.0, 0.0), (0.0, -1.0),
        )
        for errors in bad_metrics:
            for existing in (False, True):
                with self.subTest(errors=errors, existing=existing), TemporaryDirectory() as directory:
                    root = Path(directory)
                    candidate, output = root / 'candidate.onnx', root / 'output.onnx'
                    candidate.write_bytes(b'invalid model')
                    if existing:
                        output.write_bytes(b'previous model')
                    with self.assertRaisesRegex(ValueError, 'ONNX export rejected'):
                        publish_validated_export(candidate, output, *errors)
                    self.assertTrue(candidate.exists())
                    if existing:
                        self.assertEqual(output.read_bytes(), b'previous model')
                    else:
                        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
