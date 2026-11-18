// Spike #0：判定 Runtime 阶梯（spec §3.2 / D4）。
// 用法（均在 plugins/db-pro 目录下执行）：
//   node --openssl-legacy-provider spike/spike-openssl.js [--connect]
//   ELECTRON_RUN_AS_NODE=1 <electron二进制> --openssl-legacy-provider spike/spike-openssl.js --connect
'use strict';
const crypto = require('node:crypto');

function legacyProbe() {
  // OpenSSL 3 默认 provider 不含 DES/MD4 等 legacy 算法；开 legacy provider 后可见。
  // 达梦握手加密依赖 legacy cipher（spec §1.3 事实 3）。
  let desEde3Cbc = false;
  try {
    crypto.createCipheriv('des-ede3-cbc', Buffer.alloc(24), Buffer.alloc(8));
    desEde3Cbc = true;
  } catch {
    desEde3Cbc = false;
  }
  return { md4: crypto.getHashes().includes('md4'), desEde3Cbc };
}

async function dmConnect() {
  const dmdb = require('dmdb');
  const host = process.env.DBPRO_DM_HOST ?? '127.0.0.1';
  const port = process.env.DBPRO_DM_PORT ?? 15236;
  const user = process.env.DBPRO_DM_USER ?? 'SYSDBA';
  const password = process.env.DBPRO_DM_PASSWORD ?? 'SYSDBA';
  // dmdb 连接属性（index.d.ts）：connectString 须为完整 dm:// URL 形态（"URL must start with 'dm://'"）
  const url = `dm://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
  const pool = await dmdb.createPool({ connectString: url });
  const conn = await pool.getConnection();
  await conn.execute('SELECT 1 AS OK FROM DUAL');
  await conn.close();
  await pool.close();
}

async function main() {
  console.log('node:', process.version, '| execPath:', process.execPath);
  console.log('execArgv:', process.execArgv.join(' '));
  console.log('legacy algorithms:', JSON.stringify(legacyProbe()));
  if (process.argv.includes('--connect')) {
    await dmConnect();
    console.log('[dm] legacy provider 生效且达梦握手成功');
  }
}
main().catch((err) => {
  console.error('[spike] 失败:', err.message);
  process.exit(1);
});
