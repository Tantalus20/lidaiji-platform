#!/usr/bin/env python3
"""tools/workspace.py 工作区解析契约（P0：private fail-closed、outputRoot、模式）。

只使用标准库；不读取真实私人内容仓库。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.workspace import resolve_workspace  # noqa: E402

LIDAIJI_ENV_KEYS = (
    "LIDAIJI_WORKSPACE_MODE",
    "LIDAIJI_CONTENT_REPO_ROOT",
    "LIDAIJI_CONTENT_ROOT",
    "LIDAIJI_AUTHOR_NOTES_ROOT",
    "LIDAIJI_SITE_OVERRIDES_ROOT",
    "LIDAIJI_DIST_ROOT",
)


def clean_environment() -> dict[str, str]:
    return {key: "" for key in LIDAIJI_ENV_KEYS}


class WorkspaceResolutionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "platform"
        (self.root / "examples" / "demo-content").mkdir(parents=True)
        (self.root / "examples" / "demo-author-notes").mkdir(parents=True)
        (self.root / "examples" / "demo-site-overrides").mkdir(parents=True)
        self.addCleanup(self._tmp.cleanup)

    def make_private_repo(self, relative: str = "../private-content") -> Path:
        repo = (self.root / relative).resolve()
        (repo / "content").mkdir(parents=True)
        (repo / "data" / "author-notes").mkdir(parents=True)
        return repo

    def write_config(self, data: dict) -> None:
        (self.root / ".lidaiji-workspace.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )

    def test_auto_without_workspace_uses_demo_and_never_platform_content(self):
        with mock.patch.dict(os.environ, clean_environment()):
            workspace = resolve_workspace(self.root, writable_demo=False)
        self.assertEqual(workspace.mode, "demo")
        self.assertEqual(Path(workspace.contentRoot), (self.root / "examples" / "demo-content").resolve())
        self.assertNotEqual(Path(workspace.contentRepoRoot).resolve(), self.root)
        self.assertFalse((self.root / "content").exists())

    def test_private_mode_without_workspace_fails_closed(self):
        with mock.patch.dict(os.environ, clean_environment()):
            with self.assertRaises(ValueError):
                resolve_workspace(self.root, mode="private")

    def test_private_mode_invalid_repo_fails_closed(self):
        self.write_config({"contentRepoRoot": "../does-not-exist"})
        with mock.patch.dict(os.environ, clean_environment()):
            with self.assertRaises(ValueError):
                resolve_workspace(self.root, mode="private")

    def test_auto_with_config_resolves_private_roots(self):
        repo = self.make_private_repo()
        self.write_config({"contentRepoRoot": "../private-content"})
        with mock.patch.dict(os.environ, clean_environment()):
            workspace = resolve_workspace(self.root)
        self.assertEqual(workspace.mode, "private")
        self.assertEqual(Path(workspace.contentRepoRoot), repo)
        self.assertEqual(Path(workspace.contentRoot), repo / "content")
        self.assertEqual(Path(workspace.authorNotesRoot), repo / "data" / "author-notes")
        self.assertEqual(Path(workspace.outputRoot), self.root.resolve() / "dist")

    def test_output_root_override_from_config_and_env(self):
        self.make_private_repo()
        self.write_config({"contentRepoRoot": "../private-content", "outputRoot": "build-out"})
        with mock.patch.dict(os.environ, clean_environment()):
            workspace = resolve_workspace(self.root)
        self.assertEqual(Path(workspace.outputRoot), self.root.resolve() / "build-out")

        env_dist = self.root / "env-dist"
        environment = {**clean_environment(), "LIDAIJI_DIST_ROOT": str(env_dist)}
        with mock.patch.dict(os.environ, environment):
            workspace = resolve_workspace(self.root)
        self.assertEqual(Path(workspace.outputRoot), env_dist.resolve())

    def test_config_absolute_private_path_rejected(self):
        repo = self.make_private_repo()
        self.write_config({"contentRepoRoot": str(repo)})
        with mock.patch.dict(os.environ, clean_environment()):
            with self.assertRaises(ValueError):
                resolve_workspace(self.root)

    def test_environment_override_allows_absolute_repo(self):
        repo = self.make_private_repo()
        environment = {**clean_environment(), "LIDAIJI_CONTENT_REPO_ROOT": str(repo)}
        with mock.patch.dict(os.environ, environment):
            workspace = resolve_workspace(self.root, mode="private")
        self.assertEqual(workspace.mode, "private")
        self.assertEqual(Path(workspace.contentRepoRoot), repo)

    def test_demo_mode_ignores_workspace_config(self):
        repo = self.make_private_repo()
        self.write_config({"contentRepoRoot": "../private-content"})
        with mock.patch.dict(os.environ, clean_environment()):
            workspace = resolve_workspace(self.root, mode="demo")
        self.assertEqual(workspace.mode, "demo")
        self.assertNotEqual(Path(workspace.contentRepoRoot), repo)

    def test_unknown_mode_rejected(self):
        with mock.patch.dict(os.environ, clean_environment()):
            with self.assertRaises(ValueError):
                resolve_workspace(self.root, mode="sometimes")

    def test_workspace_environment_exposes_output_root(self):
        self.make_private_repo()
        self.write_config({"contentRepoRoot": "../private-content"})
        with mock.patch.dict(os.environ, clean_environment()):
            workspace = resolve_workspace(self.root)
        self.assertEqual(workspace.environment()["LIDAIJI_DIST_ROOT"], workspace.outputRoot)


if __name__ == "__main__":
    unittest.main()
