# peekMyAgent 数据库迁移指南

更新时间：2026-07-12

## 当前契约

peekMyAgent 的 SQLite schema 由 `src/persistence/migrations/` 唯一拥有：

- `index.mjs` 定义产品 migration、当前版本和当前 schema shape 校验；
- `runner.mjs` 负责版本检查、顺序执行、事务和失败回滚；
- `src/core/persistence-store.mjs` 只负责打开连接、调用 migration，再提供持久化行为。

当前 `PRAGMA user_version` 为 1。版本 0 表示早期未显式版本化的数据库，不表示数据库没有表。

## 打开数据库的生命周期

1. 创建 SQLite connection。
2. 为当前 connection 启用 foreign keys。
3. 读取 `PRAGMA user_version`。
4. 若数据库版本高于当前程序支持版本，立即拒绝打开。
5. 在一个 `BEGIN IMMEDIATE` 事务中顺序执行 pending migrations。
6. 每个 migration 完成后，在同一事务中推进 `user_version`。
7. 校验当前版本必需的表和字段。
8. 提交事务，再启用 WAL 和文件权限加固。

任一步失败都会回滚整个 migration batch。失败时不能留下“DDL 已执行但版本号未更新”或“版本号已更新但字段缺失”的半升级状态。

## 如何添加 migration

需要变更表、字段、索引或持久化约束时：

1. 在 `STORE_MIGRATIONS` 末尾追加连续版本，不能改写已经发布的 migration。
2. 提升 `CURRENT_STORE_SCHEMA_VERSION`。
3. migration 必须有稳定名称和单一 `up(db)` 实现。
4. 同步更新 `REQUIRED_COLUMNS` 或后续更完整的 schema validator。
5. 保证旧字段和数据在升级后仍可读取；需要回填时必须在 migration 中显式完成。
6. 增加从上一个真实版本升级的 fixture，不只测试空数据库。
7. 更新架构、路线图和用户可感知的数据兼容性说明。

示意：

```js
{
  version: 2,
  name: "add_capture_provenance_version",
  up(db) {
    db.exec("ALTER TABLE model_requests ADD COLUMN provenance_version INTEGER NOT NULL DEFAULT 1");
  },
}
```

不要在 `PersistenceStore` 构造函数、业务 repository 或 Server route 中临时执行 DDL。

## 兼容性边界

- **向前升级：** 支持从任意已发布旧版本依次升级到当前版本。
- **重复打开：** 当前版本打开必须幂等，不重复执行 migration。
- **降级：** 当前不提供自动 downgrade。旧程序看到未来版本必须拒绝写入。
- **备份：** 未来包含大量数据重写或不可逆转换的 migration，应在产品层先完成备份/空间检查设计，不能只依赖 SQLite 事务。
- **跨平台：** migration 不得依赖 shell、平台路径或系统命令；必须能在 macOS、Windows、Linux 的 Node `DatabaseSync` 上执行。

## 验证命令

开发时先运行：

```bash
npm run smoke:persistence-migrations
npm run smoke:persistence-store
npm run smoke:request-tree
npm run smoke:maintenance
```

提交前运行当前平台 release profile。migration 相关修改属于高平台风险，发布前还必须通过 macOS、Windows、Linux CI 和真实平台候选版本验证。
