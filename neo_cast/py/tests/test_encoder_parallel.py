"""Numerical contracts for equivalent, batched encoder execution."""
from __future__ import annotations

import copy
import types
import unittest

import torch
from torch.nn import functional as F

from factory.encoders import DiagonalSSM, TimesBlock
from factory.build_model import build_model
from tests.test_recipe_v3 import recipe


def sample_loop_reference(model: TimesBlock, x: torch.Tensor) -> torch.Tensor:
    """Original sample-local operator, before grouping convolution batches."""
    periods, weights = model.periods(x)
    length, width = x.shape[1:]
    outputs = []
    for index, sample in enumerate(x.split(1)):
        branches = []
        for period_tensor in periods[index]:
            period = int(period_tensor.item())
            padded_len = ((length + period - 1) // period) * period
            grid = F.pad(sample, (0, 0, 0, padded_len - length))
            grid = grid.reshape(1, padded_len // period, period, width).permute(0, 3, 1, 2).contiguous()
            restored = model.conv(grid).permute(0, 2, 3, 1).reshape(1, padded_len, width)[:, :length]
            branches.append(restored)
        outputs.append((torch.stack(branches, -1) * weights[index].to(x.dtype)).sum(-1))
    return x + torch.cat(outputs, 0)


class EncoderParallelTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(814)
        torch.set_num_threads(1)

    def compare_outputs_and_gradients(self, model, x, reference, *, atol=2e-5, rtol=2e-4):
        actual = model(x)
        expected = reference(model, x)
        torch.testing.assert_close(actual, expected, atol=atol, rtol=rtol)
        probe = torch.randn_like(actual) / actual.numel() ** 0.5
        variables = (x, *model.parameters())
        left = torch.autograd.grad((actual * probe).sum(), variables)
        right = torch.autograd.grad((expected * probe).sum(), variables)
        for index, (a, b) in enumerate(zip(left, right)):
            with self.subTest(gradient=index):
                self.assertTrue(torch.isfinite(a).all())
                torch.testing.assert_close(a, b, atol=atol, rtol=rtol)

    def test_ssm_fft_matches_recurrence_and_all_gradients(self):
        for length in (1, 2, 17, 168, 257, 1024):
            with self.subTest(length=length):
                self.compare_outputs_and_gradients(
                    DiagonalSSM(8, 7), torch.randn(3, length, 8, requires_grad=True),
                    lambda model, x: model.forward_state(x)[0],
                )

    def test_ssm_extreme_stable_timescales_causality_and_streaming(self):
        model = DiagonalSSM(4, 5)
        with torch.no_grad():
            model.dt_raw.copy_(torch.tensor([-15., -3., 0., 5.]))
        x = torch.randn(2, 168, 4, requires_grad=True)
        self.compare_outputs_and_gradients(model, x, lambda model, x: model.forward_state(x)[0])
        original = model(x)
        changed = x.detach().clone()
        changed[:, 83:] += 10
        torch.testing.assert_close(model(changed)[:, :83], original[:, :83], atol=2e-5, rtol=2e-4)
        a, state = model.forward_state(x[:, :83])
        b, _ = model.forward_state(x[:, 83:], state)
        torch.testing.assert_close(torch.cat((a, b), 1), original, atol=2e-5, rtol=2e-4)

    def test_timesblock_grouping_matches_original_and_all_gradients(self):
        for batch, length, top_k in ((1, 17, 2), (4, 17, 8), (8, 24, 4), (3, 33, 6)):
            with self.subTest(batch=batch, length=length, top_k=top_k):
                self.compare_outputs_and_gradients(
                    TimesBlock(4, 7, top_k, 2),
                    torch.randn(batch, length, 4, requires_grad=True), sample_loop_reference,
                )

    def test_timesblock_ties_duplicate_periods_and_sample_independence(self):
        model = TimesBlock(4, 7, 8, 2)
        zeros = torch.zeros(4, 17, 4, requires_grad=True)
        periods, _ = model.periods(zeros)
        self.assertLess(len(set(periods[0].tolist())), model.top_k)
        self.compare_outputs_and_gradients(model, zeros, sample_loop_reference)
        x = torch.randn(4, 17, 4)
        with torch.no_grad():
            actual = model(x)
            expected = torch.cat([model(sample) for sample in x.split(1)])
            torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)
            x[1:] = 100 * torch.randn_like(x[1:])
            torch.testing.assert_close(model(x)[0], actual[0], atol=2e-5, rtol=2e-4)

    def test_timesblock_convolution_batches_are_bounded(self):
        model = TimesBlock(4, 7, 8, 2)
        batches = []
        handle = model.conv.register_forward_pre_hook(lambda module, args: batches.append(args[0].size(0)))
        try:
            model(torch.zeros(4, 17, 4))
        finally:
            handle.remove()
        self.assertTrue(any(batch > 1 for batch in batches))
        self.assertLessEqual(max(batches), 4)
        self.assertLess(len(batches), 4 * 8)
        periods, _ = model.periods(torch.zeros(4, 17, 4))
        unique_sample_periods = sum(len(set(row)) for row in periods.tolist())
        self.assertEqual(sum(batches), unique_sample_periods)

    def test_checkpoint_compatibility_and_short_optimizer_trajectory(self):
        for model, reference in ((DiagonalSSM(4, 3), lambda model, x: model.forward_state(x)[0]),
                                 (TimesBlock(4, 7, 3, 2), sample_loop_reference)):
            with self.subTest(model=type(model).__name__):
                previous = copy.deepcopy(model)
                previous.forward = types.MethodType(reference, previous)
                model.load_state_dict(previous.state_dict(), strict=True)
                self.assertEqual(list(model.state_dict()), list(previous.state_dict()))
                optimizers = [torch.optim.Adam(item.parameters(), lr=3e-4) for item in (model, previous)]
                for _ in range(5):
                    x, y = torch.randn(3, 17, 4), torch.randn(3, 17, 4)
                    losses = []
                    for item, optimizer in zip((model, previous), optimizers):
                        optimizer.zero_grad()
                        loss = (item(x) - y).square().mean()
                        loss.backward()
                        optimizer.step()
                        losses.append(loss.detach())
                    torch.testing.assert_close(*losses, atol=2e-5, rtol=2e-4)

    def test_complete_recipe_models_keep_checkpoint_and_prediction_contracts(self):
        for name, layout, embedding in (("diagonal_ssm", "sequence_latent", "none"),
                                         ("diagonal_ssm", "channel_sequence", "patch"),
                                         ("timesblock_encoder", "sequence_latent", "none"),
                                         ("timesblock_encoder", "channel_sequence", "none")):
            with self.subTest(name=name, layout=layout, embedding=embedding):
                specification = recipe(name)
                specification["representation"]["layout"] = layout
                if embedding == "patch":
                    specification["embedding"] = {"type": "patch", "patch_len": 4, "stride": 2,
                                                   "d_model": specification["backbone"]["d_model"]}
                    specification["representation"]["readout"] = "flatten"
                model = build_model({"recipe": specification, "num_channels": 3,
                                     "num_target_channels": 1, "num_output_channels": 1,
                                     "num_past_covariate_channels": 2}, 24, 4)
                previous = copy.deepcopy(model)
                for module in previous.modules():
                    if isinstance(module, DiagonalSSM):
                        module.forward = types.MethodType(lambda item, x: item.forward_state(x)[0], module)
                    elif isinstance(module, TimesBlock):
                        module.forward = types.MethodType(sample_loop_reference, module)
                model.load_state_dict(previous.state_dict(), strict=True)
                x = torch.randn(3, 24, 3, requires_grad=True)
                actual, expected = model(x), previous(x)
                self.assertEqual(actual.shape, (3, 4, 1))
                torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)
                torch.testing.assert_close(torch.autograd.grad(actual.sum(), x)[0],
                                           torch.autograd.grad(expected.sum(), x)[0], atol=2e-5, rtol=2e-4)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA is unavailable")
    def test_cuda_outputs_and_gradients(self):
        # Validate the operators with strict FP32 convolution. Under TF32,
        # cuDNN can select different reduced-precision kernels for batch=1 and
        # batched convolution; its effect is covered separately below.
        with torch.backends.cudnn.flags(allow_tf32=False):
            for model, reference in ((DiagonalSSM(64, 32), lambda model, x: model.forward_state(x)[0]),
                                     (TimesBlock(64, 128, 8, 4), sample_loop_reference)):
                with self.subTest(model=type(model).__name__):
                    self.compare_outputs_and_gradients(
                        model.cuda(), torch.randn(4, 168, 64, device="cuda", requires_grad=True), reference,
                        atol=5e-5, rtol=5e-4,
                    )

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA is unavailable")
    def test_cuda_runtime_precision_and_short_training(self):
        previous_precision = torch.get_float32_matmul_precision()
        try:
            torch.set_float32_matmul_precision("high")  # train.py's policy
            model = TimesBlock(64, 128, 8, 4).cuda()
            previous = copy.deepcopy(model)
            previous.forward = types.MethodType(sample_loop_reference, previous)
            optimizers = [torch.optim.Adam(item.parameters(), lr=3e-4) for item in (model, previous)]
            for _ in range(3):
                x = torch.randn(4, 168, 64, device="cuda")
                y = torch.randn_like(x)
                outputs, gradients, losses = [], [], []
                for item, optimizer in zip((model, previous), optimizers):
                    optimizer.zero_grad()
                    output = item(x)
                    loss = (output - y).square().mean()
                    loss.backward()
                    outputs.append(output.detach())
                    gradients.append(torch.cat([p.grad.flatten() for p in item.parameters()]))
                    losses.append(loss.detach())
                    optimizer.step()
                # Relative L2 treats near-zero elements fairly while bounding
                # the TF32/batched-kernel and optimizer trajectory differences.
                for a, b in (outputs, gradients):
                    self.assertLess(((a - b).norm() / b.norm()).item(), 2e-3)
                torch.testing.assert_close(*losses, atol=2e-4, rtol=2e-3)
        finally:
            torch.set_float32_matmul_precision(previous_precision)


if __name__ == "__main__":
    unittest.main()
