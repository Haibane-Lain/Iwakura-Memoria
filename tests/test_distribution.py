"""Packaging contract for the Windows installer and the auto-update feed.

These are deliberately boring assertions: they catch a version bump that only
touched one package file, an update URL drifting off the canonical repository,
or someone turning the one-click per-user installer back into an all-users
install that needs admin.
"""
from __future__ import annotations

import json
import re

from app import config

ROOT = config.PROJECT_ROOT
CANONICAL_RELEASES = (
    "https://github.com/Haibane-Lain/Iwakura-Memoria/releases/latest/download"
)
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _json(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def test_versions_agree_and_are_semver() -> None:
    root_version = _json("package.json")["version"]
    electron_version = _json("electron/package.json")["version"]
    assert root_version == electron_version
    assert SEMVER.fullmatch(electron_version), electron_version


def test_installer_is_one_click_per_user_and_keeps_writing_data() -> None:
    build = _json("electron/package.json")["build"]
    nsis = build["nsis"]
    assert build["appId"] == "com.lain.iwakuramemoria"
    assert build["productName"] == "Iwakura Memoria"
    assert nsis["oneClick"] is True
    assert nsis["perMachine"] is False
    assert nsis["allowToChangeInstallationDirectory"] is False
    # Uninstalling the app must never remove the user's projects.
    assert nsis["deleteAppDataOnUninstall"] is False
    assert nsis["differentialPackage"] is True
    assert "${version}" in build["artifactName"]


def test_update_feed_is_the_canonical_github_latest_release() -> None:
    build = _json("electron/package.json")["build"]
    publish = build["publish"]
    assert publish == [{"provider": "generic", "url": CANONICAL_RELEASES}]


def test_updater_is_packaged_and_publishing_is_left_to_ci() -> None:
    package = _json("electron/package.json")
    assert "electron-updater" in package["dependencies"]
    assert "electron-log" in package["dependencies"]
    assert "--publish never" in package["scripts"]["dist"]
    files = package["build"]["files"]
    assert "updater.js" in files
    assert "update-utils.js" in files


def test_release_workflow_builds_on_windows_from_a_tag() -> None:
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    assert "tags:" in workflow and '"v*"' in workflow
    assert "windows-latest" in workflow
    assert "scripts\\build\\build.bat --nopause" in workflow
    assert "latest.yml" in workflow
