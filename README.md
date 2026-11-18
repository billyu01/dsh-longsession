# dsh-longsession

DSH（DeepSeek Harness）长会话压缩治理插件。

只做一件事：把官方「一次压掉几十万 token」的压缩，改造成**按工作集触发、小步、可防抖**的增量压缩。

## 为什么

实测 13 个长会话、36 次压缩：压缩触发点本身不是主要问题（33 次自动压缩都发生了），问题是一次压缩中位数删掉 49 万 token、只换回 1.3 万字符摘要；压缩后模型反复重读同一文件（最多 75 次）、重复执行旧命令（最多 18 次）。所以治理目标是「更早、更小步、可防抖」，而不是把窗口百分比从 80% 改成某个固定值。

## 工作方式

每次请求前（只在每轮第一步执行压缩检查）：

```text
工作集 = 系统提示 token + 请求固定开销 + 最近 12 个消息节点的 token
```

满足全部条件才压缩：

1. 压力不超过窗口的 90%（接近溢出时让位给官方兜底）；
2. 压力 > 工作集 × `slack`（默认 3 倍）；
3. 距上次压缩 ≥ `minStepsBetween` 个模型请求步（默认 60，按每次请求前计数，不是按轮）；
4. 距上次压缩的增量 ≥ 工作集 × `minGrowthRatio`（默认 1 倍）；
5. 预计释放量 ≥ 一个工作集。

压缩范围：从尾部保留 `工作集 × keepFactor`（默认 1.5）的近期消息，其余从第 1 个表层节点开始作为候选区间；单次释放不超过三个上限的较小值：

- `工作集 × maxFreeWorkSets`（默认 2 倍，防止再次出现「一次删几十万」）；
- `压力 × maxFreeRatio`（默认 60%）；
- `窗口 × 0.5`。

切点必须通过官方的工具调用/结果配对校验，失败就向前退一格重试。

官方 80% 阈值完全保留：本插件只做更早、更小的补充压缩，出问题也能退回官方行为。

## 短会话无感

短会话到不了触发条件（第 2 轮起、压力超工作集 3 倍、60 步冷却），所以行为与安装前一致：

- 不显示任何提示词内容；
- 不产生额外模型调用；
- 不写任何本地文件。

## 安装

```text
git clone https://github.com/billyu01/dsh-longsession.git
```

然后在 Harness 里安装这个目录：

```text
plugin_manager install_bundle target: <克隆下来的目录绝对路径>
```

也可以直接从 GitHub 安装：

```text
plugin_manager install_bundle target: github:billyu01/dsh-longsession
```

安装后**新建会话**才会挂载；已有会话保持启动时的插件版本。

## 配置

```yaml
- id: longsession-governor
  name: 'dsh-longsession/governor'
  config:
    slack: 3              # 压力超过工作集的倍数
    keepFactor: 1.5       # 压回工作集的倍数
    minStepsBetween: 60   # 冷却：两次压缩之间的最少请求步数
    minGrowthRatio: 1     # 最小新增量（相对工作集）
    maxFreeWorkSets: 2    # 单次释放上限（相对工作集）
    maxFreeRatio: 0.6     # 单次释放上限（相对当前压力）
    recentNodes: 12       # 估算工作集时保留的近期节点数
    debug: false          # 打开后每次决策写一行 Host 日志（默认关闭）
```

### 调参建议

- **压缩太频繁**：加大 `minStepsBetween`（比如 80～120），或减小 `maxFreeWorkSets` 让每次压得更少但更勤。
- **上下文降不下来**：加大 `slack` 没有意义，应该加大 `maxFreeWorkSets`（比如 3）或减小 `keepFactor`。
- **想看它到底做了什么**：临时把 `debug` 设为 `true`，日志里会出现 `longsession-governor: {...}` 一行（只在 Host 日志中，不写文件、不进模型上下文）。

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

10 项单测覆盖：无窗口、低压力、冷却、冷却满足、溢出兜底、正常压缩、超大压力下释放仍受工作集上限约束、增长不足、区间选择、无有效切点。

## 变更记录

- `v2.1.1`：图标改成与 DSH 官方插件一致的 36×36、渐变填充、圆角风格。
- `v2.1.0`：冷却改为按真实请求步数（默认 60）；单次释放增加「工作集 × 2」绝对上限；新增默认关闭的 `debug` 日志。
- `v2.0.0`：只保留压缩治理，移除状态卡、`/care` 与遥测文件。
- `v1.0.0`：初始版本。

## 回退

```text
plugin_manager remove_bundle target: dsh-longsession
```

移除后新建会话回到官方标准预设。

## 兼容性

基于 DSH 0.2.2-rc.1 生成。预设覆盖部分来自随包发布的 `@deepseek-ai/dsh-web-app`（MIT），升级后请重新生成。
