# Worktree Sidebar

Two replacements for the standard Spaces and Agents blocks. A linked Git worktree space can expand to show its tabs. In **Grouped by space** view, the Agents panel has a chevron on each group and remembers which groups you close.

Expanded worktrees show the live agent title and icon when available. Unnamed shells display their tab position, such as **Shell 2**. Right-click a space and choose **New terminal** to start a plain shell there using the existing checkout.

## Install

Copy all three folders under `mods/` into your Herdr app's `mods/` directory and run `herdr-app check` on each copied folder. In a personal layout, set the Spaces block's `content.mod` to `worktree-spaces` and the Agents block's `content.mod` to `worktree-agents`. Keep the existing block IDs. Built against Herdr 0.1.16.

The Spaces mod runs Git in live terminal folders to see whether a space is in a linked worktree and to display branch information. It checks connected machines through Herdr and saves fold preferences in local mod storage. Both panels use bundled Herdr icons and controls.

Adapted from the bundled [Herdr app](https://github.com/herdrdev/herdr-app) Spaces and Agents panels and context menu under [Apache 2.0](../licenses/herdr-app-Apache-2.0.txt).
