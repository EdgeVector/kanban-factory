#!/usr/bin/env python3
"""install-launchd.sh update must reset to origin/main, not local main.

The live factory worktree checked out local `main` and froze it. The old
`update` path did `reset --hard main`, which is a no-op on that tree, so
:4177 served Jul-23 code after origin/main already had ship-meter.mjs.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "install-launchd.sh"


def run(args, cwd=None, env=None, check=True):
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=check,
        text=True,
        capture_output=True,
    )


def git(cwd, *args):
    return run(["git", "-C", str(cwd), *args])


def write_commit(repo: Path, name: str, body: str) -> str:
    (repo / "marker.txt").write_text(body + "\n", encoding="utf-8")
    git(repo, "add", "marker.txt")
    git(repo, "commit", "-m", name)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


class UpdateTracksOriginMain(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.upstream = root / "upstream.git"
        self.clone = root / "install"
        run(["git", "init", "--bare", str(self.upstream)])

        seed = root / "seed"
        run(["git", "clone", str(self.upstream), str(seed)])
        git(seed, "config", "user.email", "test@example.com")
        git(seed, "config", "user.name", "test")
        git(seed, "checkout", "-b", "main")
        (seed / "scripts").mkdir()
        (seed / "scripts" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (seed / "scripts" / "install-launchd.sh").write_text(
            SCRIPT.read_text(encoding="utf-8"), encoding="utf-8"
        )
        os.chmod(seed / "scripts" / "install-launchd.sh", 0o755)
        os.chmod(seed / "scripts" / "run.sh", 0o755)
        git(seed, "add", "scripts")
        self.old = write_commit(seed, "old main", "stale")
        git(seed, "push", "-u", "origin", "main")
        self.new = write_commit(seed, "new main", "fresh")
        git(seed, "push", "origin", "main")

        run(["git", "clone", str(self.upstream), str(self.clone)])
        git(self.clone, "config", "user.email", "test@example.com")
        git(self.clone, "config", "user.name", "test")
        git(self.clone, "checkout", "main")
        git(self.clone, "reset", "--hard", self.old)
        # Local main is behind; origin/main is already fetched at clone time
        # and then we reset local only, so origin/main stays at self.new.
        self.assertEqual(git(self.clone, "rev-parse", "HEAD").stdout.strip(), self.old)
        self.assertEqual(
            git(self.clone, "rev-parse", "refs/remotes/origin/main").stdout.strip(),
            self.new,
        )

    def test_update_resets_to_origin_main_not_local_main(self):
        env = os.environ.copy()
        env["KANBAN_FACTORY_SKIP_LAUNCHD"] = "1"
        # PATH without last-stack-forge-git so the test talks to the file remote.
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        result = run(
            ["bash", str(self.clone / "scripts" / "install-launchd.sh"), "update"],
            cwd=self.clone,
            env=env,
        )
        self.assertIn("origin/main", result.stdout)
        head = git(self.clone, "rev-parse", "HEAD").stdout.strip()
        self.assertEqual(head, self.new)
        self.assertEqual((self.clone / "marker.txt").read_text(encoding="utf-8"), "fresh\n")

    def test_old_local_main_reset_would_stay_stale(self):
        # Document the bug the new update path replaces.
        git(self.clone, "checkout", "-B", "main", "main")
        git(self.clone, "reset", "--hard", "main")
        self.assertEqual(git(self.clone, "rev-parse", "HEAD").stdout.strip(), self.old)


if __name__ == "__main__":
    unittest.main()
