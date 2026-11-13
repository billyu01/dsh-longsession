# dsh-longsession

DSH（DeepSeek Harness）长会话增强插件。

一个包，三件事：

1. **任务状态卡**：把目标、未完成清单、最后一条人类指令、最近编辑的文件做成一张很小的系统提示卡片。压缩永远不会动系统提示节点，所以压缩之后模型不用重新摸状态。
2. **自适应增量压缩**：按「工作集」而不是固定窗口百分比决定何时压缩；只在轮次边界动手；每次只压最老的一段；带冷却与增长门槛防抖。官方 80% 阈值保留为安全兜底。
3. **上下文观测**：每 10 步把上下文压力写进本地 JSONL，并提供 `/care` 命令查看当前状态。

## 短会话无感

- 上下文压力低于 60,000 token 时，状态卡不显示（`minPressureTokens`）。
- 压缩治理要求跨轮（第 2 轮起）、压力超过工作集 3 倍、距上次压缩至少 25 步，短会话不会触发。
- 因此短会话看到的提示词与行为与未安装时一致；只有长会话才会被治理。

## 安装

```text
git clone https://github.com/billyu01/dsh-longsession.git
```

然后在 Harness 里安装这个目录：

```text
plugin_manager install_bundle target: <克隆下来的目录绝对路径>
```

（也可以把目录放进任意位置，`install_bundle` 接受本地绝对路径。）

安装后：

- 状态卡立刻对所有会话生效（Host 层）。
- 压缩治理随标准预设覆盖一起生效；**新建会话**才会挂载，已有会话保持启动时的插件版本。

## 配置

`cordis.patch.yml` 第一段是全局状态卡插件：

```yaml
- id: longsession
  name: "dsh-longsession"
  config:
    minPressureTokens: 60000   # 短会话门槛
    minSteps: 6
    minHumanMessages: 1
    maxCardChars: 1200
    reportEverySteps: 10
```

第二段是标准预设覆盖，治理插件行在其中：

```yaml
- id: longsession-governor
  name: 'dsh-longsession/governor'
  config:
    slack: 3              # 压力超过工作集的倍数
    keepFactor: 1.5       # 压回工作集的倍数
    minStepsBetween: 25   # 冷却步数
    minGrowthRatio: 1     # 最小新增量
    recentNodes: 12
    maxFreeRatio: 0.6
```

## 覆盖官方预设的代价

预设的 `config` 是整体替换、不能局部合并，所以第二段复制了当前版本标准预设的完整插件清单（只多了治理行、只改了两处修剪预算，其余与官方逐行一致，有校验脚本）。

**DSH 升级后需要重新生成并重装：**

```text
python3 generate-preset.py
plugin_manager remove_bundle target: dsh-longsession
plugin_manager install_bundle target: <本目录绝对路径>
```

## 观测

- `~/.dsh/longsession-care/context-pressure.jsonl`：每 10 步一行上下文压力。
- `~/.dsh/longsession-care/governor.jsonl`：每次压缩决策（probe / skip / compact / retry）。
- 会话里输入 `/care` 查看步数、压力、清单来源和最近一次治理决策。

## 验证

```text
node --test test/render.test.mjs      # 状态卡 7 项
node --test test/governor.test.mjs    # 治理逻辑 8 项
python3 generate-preset.py            # 重新生成补丁（应与仓库内一致）
```

## 仓库结构

```text
index.js            全局状态卡插件（Host 层）
governor.js         自适应增量压缩治理（预设层）
cordis.patch.yml    两段补丁：全局插卡 + 标准预设覆盖
generate-preset.py  从本机随包发布的 asar 重新生成第二段补丁
test/               状态卡与治理逻辑的单元测试
NOTICE              第三方来源说明（压缩组预设来自 DSH 官方，MIT）
```

## 回退

```text
plugin_manager remove_bundle target: dsh-longsession
```

移除后新建会话回到官方标准预设。

## 兼容性

基于 DSH 0.2.2-rc.1 生成。预设覆盖部分来自随包发布的 `@deepseek-ai/dsh-web-app`（MIT），升级后请重新生成。
