# 发布 checklist

1. 确认 `@fyeeme/pi-subagent-core` 依赖为 npm registry 版本（`^0.3.0`，无 `file:` 残留）；core 有新改动时先发布 core 再发消费方
2. 更新版本号( 不允许发布大版本，始终按照小版本累加, 比如 1.0.1 -> 1.0.2 )
3. 更新 changelog
4. 跑 typecheck + 全量测试
5. push 代码
6. 发布 npm
