// tests/host.ts（momo-plugin）
//
// 宿主可达性与跨仓动态 import 辅助——Task 2 Ruling 范式沉淀，officepro 系列
// 测试共用。语义：env MOMO_STUDIO_ROOT 显式设置即独占（设错 → 不可达 → skip，
// 可诊断不静默回退）；未设置才探测候选 sibling 目录（宿主 checkout 目录名不
// 固定：本机为 moo-studio，官方名 momo-studio）。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveHostRoot(): string {
  const fromEnv = process.env.MOMO_STUDIO_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv);
  const candidates = [
    path.join(__dirname, '..', '..', 'momo-studio'),
    path.join(__dirname, '..', '..', 'moo-studio'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'electron', 'package.json'))) return c;
  }
  return candidates[candidates.length - 1]!;
}

export const HOST_ROOT = resolveHostRoot();

/** 宿主 checkout 可用：package.json 与已安装的 node_modules 均在位 */
export const HOST_READY =
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'package.json')) &&
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'node_modules'));

/** 宿主内部模块是否在位（如 'agent/tools/shared/sandboxed-exec.ts'——office-pro 分支设施，未合 main 前缺席） */
export function hostFileExists(relFromMain: string): boolean {
  return fs.existsSync(path.join(HOST_ROOT, 'electron', 'src', 'main', relFromMain));
}

/** 宿主内部模块动态 import（relFromMain 相对 electron/src/main，含 .ts 后缀） */
export function hostImport(relFromMain: string): Promise<unknown> {
  return import(pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', relFromMain)).href);
}

/** 宿主 bare 依赖经宿主包上下文解析（如 js-yaml——本仓不装，随宿主版本走） */
export function hostRequire<T = unknown>(name: string): T {
  const req = createRequire(path.join(HOST_ROOT, 'electron', 'package.json'));
  return req(name) as T;
}
