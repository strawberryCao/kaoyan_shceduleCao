import assert from 'node:assert/strict';
import test from 'node:test';

import { materialNamingInternals } from './material-naming.js';

const assets = [
  { assetId: 'asset-a', originalFileName: 'image.png' },
  { assetId: 'asset-b', originalFileName: '39ef4c6c96ad9123a04bff71c4b18def.jpg' },
];

test('material naming requires one meaningful new name for every asset', () => {
  assert.throws(
    () => materialNamingInternals.validateCompleteAssetNames(assets, [
      { index: 0, name: '资料一' },
    ], 32),
    (error) => error?.code === 'AI_MATERIAL_NAMES_INCOMPLETE'
      && /附件 1.*泛化/.test(error.message)
      && /附件 2.*缺少/.test(error.message),
  );

  assert.throws(
    () => materialNamingInternals.validateCompleteAssetNames(assets, [
      { index: 0, name: 'image' },
      { index: 1, name: '39ef4c6c96ad9123a04bff71c4b18def' },
    ], 32),
    (error) => error?.code === 'AI_MATERIAL_NAMES_INCOMPLETE'
      && /没有变化|泛化/.test(error.message)
      && /哈希值|没有变化/.test(error.message),
  );
});

test('material naming maps names by stable asset id and accepts reordered latest assets', () => {
  const names = materialNamingInternals.validateCompleteAssetNames(assets, [
    { index: 0, name: '定义原文' },
    { index: 1, name: '我的推导' },
  ], 32);
  assert.deepEqual(names, {
    'asset-a': '定义原文',
    'asset-b': '我的推导',
  });
  assert.doesNotThrow(() => materialNamingInternals.assertSameAssetSet(assets, [...assets].reverse()));
});

test('material naming accepts already meaningful names so stale displays can be reconciled', () => {
  const alreadyNamed = [
    { assetId: 'asset-a', originalFileName: '周期函数平均值定理表述.png' },
    { assetId: 'asset-b', originalFileName: '数形结合与夹逼准则严格证明.jpg' },
    { assetId: 'asset-c', originalFileName: '小数部分函数极限例题原题.png' },
  ];
  assert.deepEqual(materialNamingInternals.validateCompleteAssetNames(alreadyNamed, [
    { index: 0, name: '周期函数平均值定理表述' },
    { index: 1, name: '数形结合与夹逼准则严格证明' },
    { index: 2, name: '小数部分函数极限例题原题' },
  ], 32), {
    'asset-a': '周期函数平均值定理表述',
    'asset-b': '数形结合与夹逼准则严格证明',
    'asset-c': '小数部分函数极限例题原题',
  });
});

test('material naming refuses to apply across concurrent asset add or remove', () => {
  assert.throws(
    () => materialNamingInternals.assertSameAssetSet(assets, [assets[0]]),
    (error) => error?.code === 'AI_MATERIAL_ATTACHMENTS_CHANGED' && error?.status === 409,
  );
});
