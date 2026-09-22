# SafeSABR dash.js 仿真实验

[![论文](https://img.shields.io/badge/论文-arXiv%3A2605.23560-b31b1b.svg)](https://arxiv.org/abs/2605.23560)
[![SafeSABR](https://img.shields.io/badge/项目-SafeSABR-2563eb.svg)](https://github.com/luopeng69131/SafeSABR)
[![许可证](https://img.shields.io/badge/许可证-Apache--2.0-059669.svg)](LICENSE)

[English](README.md)

本仓库提供 **SafeSABR** 的浏览器端实验复现环境。SafeSABR 是一个面向高波动
Starlink 链路的风险校准自适应码率（ABR）框架。实验使用完整的 HTTP/TCP 播放链路，
包括 Chrome、dash.js、Media Source Extensions，以及运行在独立网络命名空间中的
Linux 流量整形器。

仓库包含训练完成的 SafeSABR 策略、运行时风险模型、固定的 30-session Starlink
测试集、论文中使用的全部 ABR 对比方法，以及重新生成指标和图片所需的脚本。

## Emulation 概览

![SafeSABR dash.js emulation 概览](docs/images/emulation_overview.png)

实验运行在相互隔离的 Docker 网络中。Python runner 控制基于 Chrome 的 dash.js
播放器，Nginx 视频源通过由 Starlink trace 驱动的 Linux 流量整形器传输 DASH 视频。
播放器记录 session 级测量结果，并由统一的分析流程计算 QoE 与严重风险指标。

## 参考结果

所有方法均在相同的 30 个 Starlink session 上评估，其中 US、OSN 和 VIC 各 10 个。
累计卡顿超过 10 秒的 session 被定义为严重卡顿 session；Worst-5% 表示卡顿最严重的
两个 session 的平均累计卡顿时间。

![QoE-risk operating points](artifacts/paper/qoe_severe_risk_operating_points.png)

| 方法 | QoE | 平均卡顿（秒） | 严重卡顿 session（%） | Worst-5%（秒） |
|:--|--:|--:|--:|--:|
| dash.js Dynamic | 2713.32 | **0.70** | **0.00** | **3.32** |
| RobustMPC | 3748.10 | 7.89 | 30.00 | 29.89 |
| SARA | 3758.98 | 7.96 | 30.00 | 30.89 |
| CMAB | **4479.22** | 26.42 | 43.33 | 124.14 |
| WABB | 1792.86 | 20.15 | 73.33 | 57.81 |
| Lumos | 3339.84 | 41.28 | 93.33 | 86.52 |
| StarNet | 3306.97 | 38.23 | 90.00 | 101.66 |
| **SafeSABR** | **3903.70** | **5.73** | **16.67** | **14.84** |

完整的 session 级结果和配对统计位于
[`artifacts/paper`](artifacts/paper)。

## Emulation 细节

![SafeSABR dash.js emulation 详细技术架构](docs/images/emulation_architecture.png)

每个 session 在统一的 dash.js 播放器中选择一种可插拔 ABR controller。所有方法
共享相同的 runner、浏览器、播放器服务、视频源、trace 回放和结果分析路径。

## 复现流程

### 环境要求

- 安装 Docker Engine 和 Docker Compose v2 的 Linux 系统
- Python 3.11 或更高版本
- 至少 8 GB 可用磁盘空间，用于生成 DASH 视频和构建容器
- 默认串行执行建议至少 8 GB 内存

流量整形仅在独立 Docker 容器中进行，不会在宿主机网络接口上执行流量控制命令。

### 1. 准备环境

```bash
bash scripts/prepare_runtime.sh
```

该命令会校验仓库内的模型、数据和依赖资源，生成包含六档表示的 192 秒 DASH 视频，
提取准确的 chunk 大小，并构建实验容器。

### 2. 运行 Smoke Test

```bash
bash scripts/run_smoke.sh
```

Smoke test 会在一条短 trace 上分别运行 dash.js Dynamic 和 SafeSABR。

### 3. 复现 30-Session 实验

```bash
bash scripts/run_paper_experiment.sh
```

默认依次运行全部八种方法。也可以通过公开方法名运行其中一部分：

```bash
METHODS="robustmpc sara safesabr" bash scripts/run_paper_experiment.sh
```

可用名称包括 `dashjs`、`robustmpc`、`sara`、`cmab`、`wabb`、`lumos`、
`starnet` 和 `safesabr`。脚本会自动跳过已经完成的 session，因此中断后可以使用
相同命令继续执行。

如果机器具有充足的 CPU 和内存资源，可以显式启用并发执行：

```bash
WORKERS=5 bash scripts/run_paper_experiment.sh
```

### 4. 重新生成表格和图片

```bash
python3 -m pip install -r requirements-analysis.txt
bash scripts/analyze_results.sh
```

新结果输出至 `results/paper/analysis`。浏览器计时可能随宿主机负载产生轻微波动；
论文使用的冻结结果保存在 `artifacts/paper` 中，便于核对。

## 仓库结构

| 路径 | 内容 |
|:--|:--|
| `app/` | dash.js 播放器、ABR 规则、SafeSABR 策略与 Risk-Aligned Runtime |
| `app/assets/` | 训练后的策略、运行时风险模型和基线输入 |
| `data/starlink_holdout30/` | 随仓库提供的 30-session Starlink trace |
| `data/manifests/` | 评估顺序、地区信息和 trace 元数据 |
| `runner/` | 基于 Selenium 的 Chrome 实验执行器 |
| `shaper/` | 隔离的 HTTP 视频源和 trace 回放器 |
| `tools/` | 批量运行、视频生成、结果分析与绘图脚本 |
| `artifacts/paper/` | 论文参考指标、session 结果和图片 |
| `docs/` | 实现、数据集、对比方法与复现说明 |

## 数据和模型

仓库中的 trace 由
[StarNet 测量数据集](https://github.com/ConnectedSystemsLab/StarNet)处理得到，
覆盖三个测量地区。数据来源、格式和筛选过程详见
[docs/DATASET.md](docs/DATASET.md)。

导出的 SafeSABR 策略和运行时风险模型位于 `app/assets/`。可使用以下命令校验模型、
trace、固定版本 dash.js 以及论文参考结果：

```bash
python3 scripts/verify_artifact.py
```

## 方法实现

所有方法共享相同的浏览器、视频、trace、网络整形器、码率阶梯和缓存配置。对于原始
系统采用不同播放模式或包含额外控制变量的 LEO 方法，本仓库将其码率选择部分适配到
统一的固定时长 VOD 环境。具体实现边界和参考来源见
[docs/BASELINES.md](docs/BASELINES.md)。

## 引用

```bibtex
@misc{xie2026safesabrriskcalibratedadaptivebitrate,
  title         = {SafeSABR: Risk-Calibrated Adaptive Bitrate Streaming over Starlink Networks},
  author        = {Hongjun Xie and Jiahang Zhu and Zhiming Shao and Chao Fan and Zenghui Zhang and Genke Yang and Pengcheng Luo},
  year          = {2026},
  eprint        = {2605.23560},
  archivePrefix = {arXiv},
  primaryClass  = {eess.SY},
  url           = {https://arxiv.org/abs/2605.23560}
}
```

## 致谢

本实验基于 [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 和
[StarNet](https://github.com/ConnectedSystemsLab/StarNet) 测量数据构建。感谢
[comyco-lin](https://github.com/godka/comyco-lin)、
[pensieve_retrain](https://github.com/GreenLv/pensieve_retrain) 和
[MMSys 2024 Starlink 直播实验项目](https://github.com/clarkzjw/mmsys24-starlink-livestreaming)
的作者向社区公开实现。

## 许可证

本仓库中的 SafeSABR 源代码采用 [Apache License 2.0](LICENSE) 发布。引用的第三方
软件与数据集遵循各自的许可条款。
