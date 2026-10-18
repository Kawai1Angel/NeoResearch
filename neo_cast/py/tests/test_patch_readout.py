"""Patch axis semantics, independent channels, gradients and checkpoint boundaries."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
import subprocess
import sys
import tempfile
from unittest.mock import patch

import torch
from torch import nn

from factory.build_model import build_model, PatchEmbedding, MultiScalePatchEmbedding, PatchFlattenReadout, parameter_graph_digest
from execution_contract import describe_model
from recipe_identity import recipe_identity
from validate import validate_recipe_object

ROOT = Path(__file__).resolve().parents[1]
BACKBONES = {
    'mlp': {'type': 'mlp', 'hidden_dim': 12, 'depth': 1, 'activation': 'gelu', 'dropout': 0.0},
    'transformer': {'type': 'transformer', 'd_model': 8, 'n_heads': 2, 'n_layers': 1, 'ffn_mult': 2, 'dropout': 0.0},
    'tcn': {'type': 'tcn', 'hidden_dim': 12, 'n_layers': 2, 'kernel_size': 3, 'activation': 'gelu', 'dropout': 0.0},
    'mamba': {'type': 'mamba', 'd_model': 8, 'd_state': 4, 'd_conv': 2, 'expand': 2, 'depth': 1, 'dropout': 0.0, 'backend': 'torch_reference'},
    'diagonal_ssm': {'type': 'diagonal_ssm', 'd_model': 8, 'state_dim': 4, 'depth': 1, 'dropout': 0.0},
}

def recipe(name='mlp', embedding='patch', version=3):
    r = json.loads((ROOT / 'schemas/recipe_native.example.json').read_text())
    r.update(recipe_version=f'recipe_schema_v{version}', backbone=copy.deepcopy(BACKBONES[name]),
             preprocessing={'actions': [{'type': 'none'}]}, fusion={'type': 'temporal', 'channel_mode': 'independent'},
             prediction_head={'type': 'linear', 'output_distribution': 'point'})
    r['embedding'] = ({'type': 'patch', 'patch_len': 4, 'stride': 4, 'd_model': 8} if embedding == 'patch' else
                      {'type': 'multiscale_patch', 'scales': [{'patch_len': 4, 'stride': 4}, {'patch_len': 8, 'stride': 4}], 'd_model': 8, 'num_blocks': 1}
                      if embedding == 'multiscale_patch' else {'type': 'none'})
    r['training_strategy']['loss'] = {'base': 'mse', 'horizon_weighting': 'uniform'}
    if version == 3:
        seq = name in {'mamba', 'diagonal_ssm'}
        r['representation'] = {'layout': 'channel_sequence' if seq else 'channel_latent', 'readout': ('flatten' if embedding == 'patch' else 'mean') if seq else 'none', 'latent_dim': 8}
        r['composition'] = {'type': 'single'}
    return r

def model(r):
    return build_model({'recipe': r, 'num_channels': 2}, 16, 4)

class PatchReadoutTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(42)
        torch.set_num_threads(1)

    def test_unfold_omits_tail_and_uses_shared_linear_projection(self):
        embedding = PatchEmbedding(input_len=11, patch_len=4, stride=3, d_model=4)
        with torch.no_grad():
            embedding.proj.weight.copy_(torch.eye(4)); embedding.proj.bias.zero_()
        x = torch.arange(11.).reshape(1, 11).requires_grad_()
        actual = embedding(x)
        torch.testing.assert_close(actual, torch.tensor([[[0.,1.,2.,3.],[3.,4.,5.,6.],[6.,7.,8.,9.]]]))
        actual.sum().backward()
        self.assertEqual(x.grad[0, 10].item(), 0)

    def test_feature_major_flatten_order_and_per_token_norm(self):
        readout = PatchFlattenReadout(2, 2, 4)
        with torch.no_grad():
            readout.projection.weight.copy_(torch.eye(4)); readout.projection.bias.zero_()
        x = torch.tensor([[[1., 3.], [2., 0.]]])
        torch.testing.assert_close(readout(x), torch.tensor([[-1., 1., 1., -1.]]), atol=1e-5, rtol=1e-5)

    def test_patch_order_changes_mlp_and_transformer_predictions(self):
        x = torch.randn(2, 16, 2)
        swapped = x.reshape(2, 4, 4, 2)[:, [3, 1, 2, 0]].reshape(2, 16, 2)
        for name in ['mlp', 'transformer']:
            for version in [2, 3]:
                with self.subTest(name=name, version=version):
                    m = model(recipe(name, version=version)).eval()
                    self.assertGreater((m(x)-m(swapped)).abs().max().item(), 1e-4)

    def test_every_patch_position_has_a_prediction_gradient(self):
        for name in BACKBONES:
            with self.subTest(name=name):
                m = model(recipe(name)).eval()
                captured = []
                embedding = m.model[0] if name in {'tcn','mamba','diagonal_ssm'} else m.model['embedding']
                def capture(_, __, output):
                    output.retain_grad(); captured.append(output)
                hook = embedding.register_forward_hook(capture)
                m(torch.randn(2,16,2)).square().sum().backward(); hook.remove()
                grad = captured[0].grad
                self.assertTrue(torch.all(grad.abs().sum(dim=(0,2)) > 0))

    def test_all_supported_backbones_and_heads_preserve_shapes_and_parameter_reachability(self):
        for name in BACKBONES:
            for emb in (['patch','multiscale_patch'] if name in {'mlp','transformer','tcn'} else ['patch']):
                for head in ['linear','residual_correction','identity','quantile','gaussian']:
                    with self.subTest(name=name, embedding=emb, head=head):
                        r = recipe(name, emb)
                        r['prediction_head'] = {'type':head,'output_distribution':'point'}
                        if head == 'identity': r['representation']['latent_dim'] = 4
                        if head == 'residual_correction': r['prediction_head']['correction_dim'] = 6
                        if head == 'quantile':
                            r['prediction_head'].update(output_distribution='quantile', quantiles=[0.1,0.5,0.9])
                            r['training_strategy']['loss'] = {'base':'quantile','quantiles':[0.1,0.5,0.9]}
                        if head == 'gaussian':
                            r['prediction_head'].update(output_distribution='gaussian', variance_floor=1e-6)
                            r['training_strategy']['loss'] = {'base':'gaussian_nll'}
                        self.assertEqual(validate_recipe_object(r,input_len=16), [])
                        m = model(r); x = torch.randn(2,16,2)
                        y = m.forward_quantiles(x) if head == 'quantile' else m(x)
                        self.assertEqual(tuple(y.shape),(2,4,2,3) if head=='quantile' else (2,4,2))
                        loss=y.square().mean()
                        if head=='gaussian':
                            _,scale=m.forward_distribution(x); self.assertTrue(torch.all(scale>0));loss=loss+scale.mean()
                        loss.backward()
                        for key,p in m.named_parameters():
                            self.assertIsNotNone(p.grad,key);self.assertTrue(torch.isfinite(p.grad).all(),key)
                        actual=describe_model(m)
                        self.assertEqual(actual['backbone'],name)
                        self.assertEqual(actual['embedding'],emb)
                        self.assertEqual(actual['num_parameters'],sum(p.numel() for p in m.parameters()))

    def test_v2_tcn_and_multiscale_shapes(self):
        for name in ['mlp','transformer','tcn']:
            for emb in ['patch','multiscale_patch']:
                r=recipe(name,emb,2);self.assertEqual(validate_recipe_object(r,input_len=16),[])
                self.assertEqual(tuple(model(r)(torch.randn(2,16,2)).shape),(2,4,2))

    def test_high_level_tcn_compiler_accepts_patch_without_changing_raw_default(self):
        from model_recipe import compile_model_recipe
        high=json.loads((ROOT/'schemas/model_recipe.example.json').read_text())
        high['schema_version']='model_recipe.v1'
        high['input']['history_window']=32
        high['architecture'].update(backbone='temporal_conv',d_model=8,hidden_dim=12,layers=2,multiscale_blocks=0)
        for embedding in ['auto','none','patch','multiscale_patch']:
            high['architecture']['embedding']=embedding
            compiled=compile_model_recipe(high)
            self.assertEqual(compiled['embedding']['type'],'none' if embedding=='auto' else embedding)
            self.assertEqual(validate_recipe_object(compiled,input_len=32),[])
        high['architecture']['embedding']='frequency'
        with self.assertRaisesRegex(ValueError,'incompatible'):compile_model_recipe(high)

    def test_multiscale_concatenates_in_recipe_order(self):
        m=MultiScalePatchEmbedding(input_len=16,scales=[{'patch_len':8,'stride':4},{'patch_len':4,'stride':4}],d_model=2)
        m.blocks=nn.ModuleList([])
        for index,emb in enumerate(m.embeddings):
            with torch.no_grad():emb.proj.weight.zero_();emb.proj.bias.fill_(index+1)
        out=m(torch.randn(1,16))
        self.assertEqual(out.shape,(1,7,2))
        torch.testing.assert_close(out[:,:3],torch.ones(1,3,2));torch.testing.assert_close(out[:,3:],torch.ones(1,4,2)*2)

    def test_patch_state_space_channels_share_parameters_without_mixing(self):
        for name in ['mamba','diagonal_ssm']:
            m=model(recipe(name)).eval();x=torch.randn(2,16,2);x[:,:,1]=x[:,:,0]
            torch.testing.assert_close(m(x)[:,:,0],m(x)[:,:,1])
            a=m(x);x[:,:,1]+=torch.randn(2,16)*10;b=m(x)
            torch.testing.assert_close(a[:,:,0],b[:,:,0],atol=0,rtol=0)
            self.assertGreater((a[:,:,1]-b[:,:,1]).abs().max().item(),1e-5)

    def test_activation_budget_uses_actual_patch_tokens(self):
        for name in ['mamba','diagonal_ssm']:
            r=recipe(name);r['constraints']['max_activation_elements']=200
            m=model(r);self.assertEqual(tuple(m(torch.randn(2,16,2)).shape),(2,4,2)) # 2*2*4*8=128, not 512
            r['embedding'].update(patch_len=2,stride=1)
            with self.assertRaisesRegex(ValueError,'RESOURCE_LIMIT'):model(r)(torch.randn(2,16,2))

    def test_history_gate_requires_matching_patch_grids_even_with_same_token_count(self):
        r=recipe('mamba');other=recipe('diagonal_ssm')
        r['composition']={'type':'parallel_two_branch','merge':'history_time_gate','secondary':{k:other[k] for k in ['backbone','embedding','representation']}}
        m=model(r);m(torch.randn(2,16,2)).square().mean().backward()
        for name,p in m.named_parameters():self.assertIsNotNone(p.grad,name)
        r['composition']['secondary']['embedding']={'type':'patch','patch_len':5,'stride':3,'d_model':8}
        self.assertTrue(any('token grid' in x for x in validate_recipe_object(r,input_len=16)))
        with self.assertRaisesRegex(ValueError,'token grid'):model(r)

    def test_legacy_patch_branches_use_flatten_in_both_branches(self):
        for kind,merge in [('parallel_two_branch','latent_gate'),('parallel_two_branch','forecast_step_gate'),('decomposition_two_branch',None)]:
            r=recipe('mlp');other=recipe('tcn','multiscale_patch')
            r['composition']={'type':kind,'secondary':{k:other[k] for k in ['backbone','embedding','representation']},**({'merge':merge} if merge else {'kernel_size':3})}
            self.assertEqual(validate_recipe_object(r,input_len=16),[])
            m=model(r);m(torch.randn(2,16,2)).square().mean().backward()
            for name,p in m.named_parameters():self.assertIsNotNone(p.grad,name)

    def test_invalid_patch_state_space_combinations_are_rejected(self):
        for name in ['mamba','diagonal_ssm']:
            r=recipe(name)
            bad=[]
            v=copy.deepcopy(r);v['embedding']['d_model']=4;bad.append(v)
            v=copy.deepcopy(r);v['representation']['readout']='mean';bad.append(v)
            v=copy.deepcopy(r);v['representation']['layout']='sequence_latent';bad.append(v)
            v=copy.deepcopy(r);v['fusion']={'type':'feature_mlp'};bad.append(v)
            v=copy.deepcopy(r);v['embedding']=recipe('mlp','multiscale_patch')['embedding'];bad.append(v)
            v=recipe(name,'none');v['representation']['readout']='flatten';bad.append(v)
            for v in bad:self.assertTrue(validate_recipe_object(v,input_len=16))
        r=json.loads((ROOT/'schemas/recipe_timesblock_encoder.example.json').read_text());r['embedding']=recipe()['embedding']
        self.assertTrue(validate_recipe_object(r,input_len=16))

    def test_old_mean_checkpoint_is_rejected_even_for_one_patch(self):
        for name in ['mlp','transformer']:
            r=recipe(name);r['embedding'].update(patch_len=16,stride=16)
            new=model(r);old=model(r)
            width=BACKBONES[name].get('hidden_dim',BACKBONES[name].get('d_model'))
            old.model['head']=nn.Sequential(nn.LayerNorm(width),nn.Linear(width,8))
            self.assertNotEqual(parameter_graph_digest(old),parameter_graph_digest(new))
            with self.assertRaises(RuntimeError):new.load_state_dict(old.state_dict())

    def test_patch_experiment_identity_changes_from_the_historical_mean_readout(self):
        from recipe_identity import canonical_recipe,digest,NORMALIZATION_REVISION
        for embedding in ['patch','none']:
            r=recipe('mlp',embedding);spec={'input_len':16,'channels':2,'horizon':4}
            canonical=canonical_recipe(r,input_len=16)
            architecture={k:v for k,v in canonical.items() if k not in {'training_strategy','constraints'}}
            historical=digest({'normalization_revision':NORMALIZATION_REVISION,'architecture':architecture,'input_spec':spec})
            actual=recipe_identity(r,input_spec=spec)['architecture_id']
            self.assertEqual(historical==actual,embedding=='none')

    def test_patch_exports_reconstruct_without_workspace_imports(self):
        import export
        for name, version in [('mlp', 2), ('tcn', 3), ('mamba', 3)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                r=recipe(name,version=version);config={'recipe':r,'num_channels':2}
                m=build_model(config,16,4).eval();manifest=describe_model(m)
                candidate={'model_config':config,'model_family':'recipe_factory','candidate_id':name,'recipe':r,'task':{'input_len':16,'horizons':[4]}}
                revision=manifest['runtime_semantics_revision']
                metadata=export.build_metadata(run_id='patch_'+name,model_family='recipe_factory',model_impl_entry='model_impl.py:build_model',
                    state_dict_layout='per_horizon',val_metrics={'val_avg_mse':1.0},horizons=[4],
                    training_summary={'runtime_semantics_revision':revision,'model_manifests':{'4':manifest}})
                metadata.update(input_len=16,num_channels=2,dataset_schema_version='dataset.v1')
                target=Path(directory)
                with patch.object(export,'build_preprocess_spec',return_value={}):export.write_export_files(target,metadata,candidate=candidate)
                torch.save({'runtime_semantics_revision':revision,'candidate':candidate,'state_dicts':{'4':m.state_dict()},'model_manifests':{'4':manifest}},target/'model.pt')
                x=torch.randn(1,16,2);(target/'expected.json').write_text(json.dumps({'x':x.tolist(),'y':m(x).detach().tolist()}))
                script="import sys,json,torch;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import inference;d=json.loads((Path(sys.argv[1])/'expected.json').read_text());b=inference.load_model('cpu');torch.testing.assert_close(b['models'][4](torch.tensor(d['x'])),torch.tensor(d['y']),atol=1e-5,rtol=1e-4)"
                result=subprocess.run([sys.executable,'-I','-c',script,directory],capture_output=True,text=True,timeout=60)
                self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
