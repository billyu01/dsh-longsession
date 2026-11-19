# dsh-longsession

DSH（DeepSeek Harness）长会话压缩治理插件。

只做一件事：把官方「一次压掉几十万 token」的压缩，改造成**按工作集触发、小步、有收益门槛、有耗时预算**的增量压缩。

## 设计约束

1. **策略合理**：按工作集而不是固定窗口比例决定；只在安全边界动手。
2. **成本与收益**：预计释放量不够就不压；单次释放有上限；不新增任何模型调用（只有官方压缩本身的摘要调用）。
3. **不影响 agent**：所有异常吞掉放行；压缩失败、超时都不打断本轮；只走官方压缩事务。
4. **不长时间耗时**：每次压缩带 `maxLatencyMs` 时间预算，超时即放弃；失败后有重试退避。

## 工作方式

每次请求前都会做一次便宜的检查（只读提供方报告的压力，不折叠历史）：

- 正常只在「第 2 轮起的每轮第一步」进入决策；
- 当压力超过窗口的 `emergencyRatio`（默认 60%）时，允许在一轮中间的任意步进入决策，避免长首轮把上下文推过水位。

进入决策后，满足全部条件才压缩：

0. 压力 ≥ `minPressureTokens`（默认 250,000）；
1. 压力不超过窗口的 90%（接近溢出让位给官方兜底）；
2. 压力 > 工作集 × `slack`（默认 3）；
3. 距上次压缩 ≥ `minStepsBetween` 个请求步（默认 60）；
4. 距上次压缩的增量 ≥ 工作集 × `minGrowthRatio`；
5. 预计释放量 ≥ 一个工作集，且 ≥ `minFreeTokens`（默认 50,000）——这一条就是收益门槛。

压缩范围：

```text
工作集 = 系统提示 token + 请求固定开销 + 最近 recentNodes 个消息节点
保留区 = 工作集 × keepFactor（默认 1.5）
单次释放 ≤ min(工作集 × maxFreeWorkSets, 压力 × maxFreeRatio, 窗口 × 0.5)
```

两个额外保护：

- **原始需求不进压缩区**：压缩从第一条人类消息之后开始，原始请求逐字留在上下文里，不依赖摘要转述。
- **冷却跨重启恢复**：启动时从会话日志恢复「已跑了多少步、上次压缩在第几步」，进程重启后不会立刻再压一次。

官方 80% 阈值完全保留：本插件只做更早、更小的补充压缩，出问题也能退回官方行为。

## 成本与收益

- 压缩本身不新增调用，只触发官方那一次摘要；但摘要要回放被删区间，实测输入约为释放量的 1.4 倍。
- 因此默认要求一次至少释放 50,000 token 才值得做；小会话由 `minPressureTokens` 直接挡掉。
- 单次耗时实测 10～15 秒，所以默认给 15 秒预算；超时就放弃本次（官方事务会自行闭合，不提交检查点），并在 `retryAfterFailureSteps`（默认 30 步）内不再重试。

## 短会话无感

短会话到不了触发条件，行为与安装前一致：

- 不显示任何提示词内容；
- 不产生额外模型调用；
- 不写任何本地文件。

## 安装

```text
plugin_manager install_bundle target: github:billyu01/dsh-longsession
```

固定版本：

```text
plugin_manager install_bundle target: github:billyu01/dsh-longsession#v2.3.0
```

安装后**新建会话**才会挂载；已有会话保持启动时的插件版本。

## 配置

```yaml
- id: longsession-governor
  name: 'dsh-longsession/governor'
  config:
    slack: 3                   # 压力超过工作集的倍数
    keepFactor: 1.5            # 压回工作集的倍数
    minStepsBetween: 60        # 冷却：两次压缩之间的最少请求步数
    minGrowthRatio: 1          # 最小新增量（相对工作集）
    maxFreeWorkSets: 2         # 单次释放上限（相对工作集）
    maxFreeRatio: 0.6          # 单次释放上限（相对当前压力）
    recentNodes: 12            # 估算工作集时保留的近期节点数
    minPressureTokens: 250000  # 绝对最低压力门槛
    emergencyRatio: 0.6        # 压力超过窗口这个比例时允许在任意步压缩
    minFreeTokens: 50000       # 收益门槛：预计释放低于它就不压
    maxLatencyMs: 15000        # 单次压缩时间预算
    retryAfterFailureSteps: 30 # 失败/超时后的重试退避
    debug: false               # 打开后每次决策写一行 Host 日志（默认关闭）
```

### 调参建议

- **压缩太频繁**：加大 `minStepsBetween`、`minFreeTokens`。
- **小会话被无谓压缩**：加大 `minPressureTokens`。
- **上下文降不下来**：加大 `maxFreeWorkSets`（3～4）或减小 `keepFactor`；长首轮压不到时把 `emergencyRatio` 调低。
- **不想承担压缩耗时**：减小 `maxLatencyMs`（超时次数会变多，但每次阻塞更短）。
- **想看它到底做了什么**：把 `debug` 设为 `true`，Host 日志会出现 `longsession-governor: {...}` 一行。

## 覆盖官方预设的代价

预设的 `config` 是整体替换、不能局部合并，所以本包复制了当前版本标准预设的完整插件清单（只多了治理行、只改了两处修剪预算，其余与官方逐行一致，有校验脚本）。

**DSH 升级后需要重新生成并重装：**

```text
python3 generate-preset.py
plugin_manager remove_bundle target: dsh-longsession
plugin_manager install_bundle target: <本目录绝对路径>
```

## 验证

```text
node --test test/governor.test.mjs
```

15 项单测覆盖：无窗口、低压力、绝对门槛、冷却、冷却满足、溢出兜底、正常压缩、超大压力释放上限、增长不足、收益不足、区间选择、无切点、原始请求锚点、边界判断、重启后状态恢复。

## 变更记录

- `v2.3.0`：原始需求不进压缩区；新增收益门槛 `minFreeTokens`；新增压缩时间预算 `maxLatencyMs` 与失败退避；冷却状态从会话日志恢复，跨重启不再清零。
- `v2.2.0`：新增绝对压力门槛 `minPressureTokens`；压力超过窗口 60% 时允许任意步边界压缩。
- `v2.1.1`：图标改成与 DSH 官方插件一致的 36×36 渐变圆角风格。
- `v2.1.0`：冷却改为按真实请求步数；单次释放增加「工作集 × 2」上限；新增 `debug` 日志。
- `v2.0.0`：只保留压缩治理，移除状态卡与遥测。
- `v1.0.0`：初始版本。

## 回退

```text
plugin_manager remove_bundle target: dsh-longsession
```

移除后新建会话回到官方标准预设。

## 兼容性

基于 DSH 0.2.2-rc.1 生成。预设覆盖部分来自随包发布的 `@deepseek-ai/dsh-web-app`（MIT），升级后请重新生成。
