// 四库真库集成（spec §9）：docker compose（tests/docker/）+ DBPRO_INTEGRATION=1 门控。
// 每方言独立探活：容器未起则该库 skip 不红（oracle 镜像后台拉取场景）。
// 覆盖每库：建池 → ping → 建表(exec) → 插入 → query → 元数据五件 → ddl → explain → 清理。
// 达梦/Oracle 首跑即 Review Focus #2 仲裁：API 形状不符改驱动、方言 SQL 以实测修正。
import { describe, it, expect, beforeAll } from 'vitest';
import net from 'node:net';

const ON = process.env.DBPRO_INTEGRATION === '1';

function reachable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

const DRIVER_OF = {
  mysql: () => import('../../plugins/db-pro/engine/drivers/mysql.js'),
  postgres: () => import('../../plugins/db-pro/engine/drivers/pg.js'),
  oracle: () => import('../../plugins/db-pro/engine/drivers/oracle.js'),
  dm: () => import('../../plugins/db-pro/engine/drivers/dm.js'),
};

const CASES = [
  {
    dialect: 'mysql', port: 13306, table: 'dbpro_t', // 表名按方言大小写语义：mysql/pg 保留小写，oracle/dm 折叠大写
    url: () => process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE IF EXISTS dbpro_t',
  },
  {
    dialect: 'postgres', port: 15432, table: 'dbpro_t',
    url: () => process.env.DBPRO_PG ?? 'postgres://postgres:dbpro123@127.0.0.1:15432/dbpro',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE IF EXISTS dbpro_t',
  },
  {
    dialect: 'oracle', port: 11521, table: 'DBPRO_T',
    url: () => process.env.DBPRO_ORACLE ?? 'oracle://pdbadmin:dbpro123@127.0.0.1:11521/FREEPDB1',
    createTable: 'CREATE TABLE dbpro_t (id NUMBER PRIMARY KEY, name VARCHAR2(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE dbpro_t',
  },
  {
    dialect: 'dm', port: 15236, table: 'DBPRO_T',
    url: () => process.env.DBPRO_DM ?? 'dm://SYSDBA:SYSDBA001@127.0.0.1:15236',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE dbpro_t',
  },
];

describe.skipIf(!ON)('四库集成', () => {
  for (const c of CASES) {
    describe(c.dialect, () => {
      let pool;
      let up = false;
      beforeAll(async () => {
        up = await reachable(c.port);
        if (!up) return; // 容器未起 → 本库全部用例 skip 语义（it 内守卫）
        const mod = await DRIVER_OF[c.dialect]();
        const createPool = mod.default?.createPool ?? mod.createPool;
        if (c.dialect === 'oracle') {
          // 官方 free 镜像 PDBADMIN 仅 PDB_DBA 有限权限（CREATE TABLE → ORA-01031）
          // ——system 预授 RESOURCE + USERS 配额（harness 环境准备，非被测路径）
          const admin = await createPool('oracle://system:dbpro123@127.0.0.1:11521/FREEPDB1', { queryTimeoutMs: 15_000 });
          await admin.exec('GRANT RESOURCE TO PDBADMIN').catch(() => undefined);
          await admin.exec('ALTER USER PDBADMIN QUOTA UNLIMITED ON USERS').catch(() => undefined);
          await admin.close();
        }
        pool = await createPool(c.url(), { queryTimeoutMs: 15_000 });
      });

      it('ping + 建表 + 插入', async () => {
        if (!up) return;
        await pool.ping();
        await pool.exec(c.drop).catch(() => undefined); // 幂等清场
        await pool.exec(c.createTable);
        const r = await pool.exec(c.insert);
        expect(r.affectedRows).toBeGreaterThanOrEqual(1);
      });
      it('query 返回插入行', async () => {
        if (!up) return;
        const r = await pool.query(c.select, 10);
        expect(r.rows).toEqual([[1, 'a']]);
        expect(r.columns.slice(0, 2).map((x) => String(x).toUpperCase())).toEqual(['ID', 'NAME']);
      });
      it('元数据：schemas / tables / describe / columns', async () => {
        if (!up) return;
        const schemas = await pool.listSchemas();
        expect(schemas.length).toBeGreaterThan(0);
        const tables = await pool.listTables();
        expect(tables.map((t) => String(t.name).toUpperCase())).toContain(c.table.toUpperCase());
        const d = await pool.describe(undefined, c.table);
        expect(d.columns.length).toBe(2);
        const cols = await pool.columns(undefined, c.table);
        expect(cols.map((x) => String(x.name).toUpperCase())).toEqual(['ID', 'NAME']);
      });
      it('ddl', async () => {
        if (!up) return;
        const ddl = await pool.ddl(undefined, c.table);
        expect(String(ddl).toUpperCase()).toContain(c.ddlContains);
        if (c.dialect === 'postgres') expect(String(ddl)).toContain('"public"."dbpro_t"'); // M1：缺省 schema 不落 undefined
      });
      it('explain（达梦走 lastExecInfo 特化——本用例即仲裁点）', async () => {
        if (!up) return;
        const p = await pool.explain(c.select);
        expect(p.text.length).toBeGreaterThan(0);
      });
      it('清场', async () => {
        if (!up) return;
        await pool.exec(c.drop);
        await pool.close();
      });
    });
  }
});
