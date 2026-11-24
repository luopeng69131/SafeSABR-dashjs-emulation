#!/usr/bin/env python3
"""Plot QoE-risk operating points and session-rebuffer survival curves."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


DISPLAY = {
    "dash_dynamic": "dash.js Dynamic",
    "robust_mpc": "RobustMPC",
    "sara": "SARA",
    "cmab": "CMAB",
    "starnet_mpc": "StarNet",
    "lumos_mpc": "Lumos",
    "wabb": "WABB",
    "safesabr_selective_rescue": "SafeSABR",
}

COLORS = {
    "dash_dynamic": "#6B7280",
    "robust_mpc": "#2563EB",
    "sara": "#D97706",
    "cmab": "#7C3AED",
    "starnet_mpc": "#0891B2",
    "lumos_mpc": "#059669",
    "wabb": "#92400E",
    "safesabr_selective_rescue": "#DC2626",
}

MARKERS = {
    "dash_dynamic": "o",
    "robust_mpc": "s",
    "sara": "D",
    "cmab": "X",
    "starnet_mpc": "P",
    "lumos_mpc": "^",
    "wabb": "v",
    "safesabr_selective_rescue": "*",
}


def configure_style() -> None:
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
            "font.size": 12,
            "axes.labelsize": 13,
            "axes.titlesize": 13,
            "legend.fontsize": 11,
            "xtick.labelsize": 11,
            "ytick.labelsize": 11,
            "axes.linewidth": 0.8,
        }
    )


def operating_points(summary: pd.DataFrame, output: Path) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(10.5, 4.0), constrained_layout=True)
    panels = (
        ("total_rebuffer_s", "Mean session rebuffering (s)"),
        ("severe_session_ratio", "Sessions with >10 s rebuffering (%)"),
    )
    for axis, (column, label) in zip(axes, panels):
        for _, row in summary.iterrows():
            method = row["method"]
            x_value = row[column] * (100 if column == "severe_session_ratio" else 1)
            axis.scatter(
                x_value,
                row["qoe"],
                s=190 if method == "safesabr_selective_rescue" else 100,
                marker=MARKERS[method],
                color=COLORS[method],
                edgecolor="white",
                linewidth=0.8,
                zorder=4 if method == "safesabr_selective_rescue" else 3,
                label=DISPLAY[method],
            )
        axis.set_xlabel(label)
        axis.grid(True, color="#D1D5DB", linewidth=0.65, alpha=0.7)
        axis.annotate(
            "Better",
            xy=(0.04, 0.94),
            xytext=(0.22, 0.80),
            xycoords="axes fraction",
            textcoords="axes fraction",
            color="#B91C1C",
            fontweight="bold",
            arrowprops={"arrowstyle": "->", "color": "#B91C1C", "lw": 1.6},
        )
    axes[0].set_ylabel("Mean QoE")
    axes[0].set_title("(a) QoE vs. mean rebuffering")
    axes[1].set_title("(b) QoE vs. severe-session ratio")
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=4, frameon=False, bbox_to_anchor=(0.5, 1.16))
    fig.savefig(output, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def survival_curve(sessions: pd.DataFrame, output: Path) -> None:
    fig, axis = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
    included_methods = set(sessions["method"])
    for method in (name for name in DISPLAY if name in included_methods):
        values = np.sort(
            sessions.loc[sessions["method"] == method, "total_rebuffer_s"].to_numpy(dtype=float)
        )
        survival = (len(values) - np.arange(len(values))) / len(values)
        axis.step(
            np.r_[0, values],
            np.r_[1, survival],
            where="post",
            color=COLORS[method],
            linewidth=2.5 if method == "safesabr_selective_rescue" else 1.8,
            label=DISPLAY[method],
        )
    axis.axvline(10, color="#111827", linestyle="--", linewidth=1.2, label="Severe-session threshold")
    axis.set_xlabel("Cumulative session rebuffering (s)")
    axis.set_ylabel("Fraction of sessions exceeding x")
    axis.set_xlim(left=0)
    axis.set_ylim(0, 1.02)
    axis.grid(True, color="#D1D5DB", linewidth=0.65, alpha=0.7)
    axis.legend(frameon=False, ncol=2, loc="upper right")
    fig.savefig(output, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis-dir", type=Path, required=True)
    parser.add_argument("--exclude", nargs="*", default=[])
    parser.add_argument("--suffix", default="")
    args = parser.parse_args()
    configure_style()
    summary = pd.read_csv(args.analysis_dir / "summary.csv")
    sessions = pd.read_csv(args.analysis_dir / "sessions.csv")
    if args.exclude:
        summary = summary.loc[~summary["method"].isin(args.exclude)].copy()
        sessions = sessions.loc[~sessions["method"].isin(args.exclude)].copy()
    operating_points(
        summary,
        args.analysis_dir / f"qoe_risk_operating_points{args.suffix}.png",
    )
    survival_curve(
        sessions,
        args.analysis_dir / f"rebuffer_survival{args.suffix}.png",
    )


if __name__ == "__main__":
    main()
