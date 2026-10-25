# Iwakura Memoria — tester guide

Thanks for trying Iwakura Memoria. This build is for a small group of testers.
It is a real desktop app, not a web demo, and it keeps your writing on your own
machine.

## Download and install

1. Open the latest release:
   **https://github.com/Haibane-Lain/Iwakura-Memoria/releases/latest**
2. Download **`Iwakura-Memoria-Setup-<version>.exe`**.
3. Run it. The installer is per-user, so it does **not** need administrator
   rights. It installs for your Windows account, adds a Start Menu entry and a
   desktop shortcut, and opens the app when it finishes.
4. Windows may say **“Windows protected your PC”** because the installer is not
   code-signed yet. Click **More info → Run anyway**. Only download from the
   release link above; don't run a copy someone forwarded to you.
5. If you already have an older test build of the app, close it before running
   the installer. If it was installed to a custom folder, uninstall it first;
   your writing data is kept either way.

Requirements: **Windows 10 or 11, 64-bit**. You do not need Python, Node.js,
Java, LanguageTool, or WordNet — they are all bundled.

If you'd like to verify the download, the release also contains
`SHA256SUMS.txt`. In PowerShell:

```powershell
Get-FileHash .\Iwakura-Memoria-Setup-<version>.exe -Algorithm SHA256
```

## First launch

- The app opens on the **Worlds** shelf. Click **+ New world**, then add a series
  or a book and open it. A book is a project; everything you write lives inside
  that project.
- Grammar is already set up and runs locally. Lookup (definitions, synonyms)
  works offline too.
- **Lain**, the AI assistant, is optional. To use it, open **Settings → AI
  assistant** and add your own provider key. If you never configure it, no text
  is sent anywhere.

## Where your work is stored

Your projects, settings, and chat history live here:

```
%LOCALAPPDATA%\IwakuraMemoria\data
```

Backups live beside that folder:

```
%LOCALAPPDATA%\IwakuraMemoria\backups
```

Updating or uninstalling the app does **not** delete this folder. You can copy
it to another drive as a manual backup. To make a backup from inside the app,
use **Settings → Import & export → Back up everything now**. The 10 newest
backups are kept automatically.

Please don't move or rename the folders inside `data` by hand unless you know
what you're doing; the library and links expect the layout the app created.

## Updates

The app checks for updates shortly after launch and every few hours. When one is
available it downloads in the background; when it's ready you'll see a
**Version … is ready to install** message. Click **Update** (or open
**About** in the top bar) and then **Restart & update**.

- Your open documents are saved first. You can also leave **Back up my library
  before restarting** checked.
- Choose **Later** if you're in the middle of something. Nothing is installed
  until you click Restart, and quitting normally does not install it either.
- **About** also has a **Check for updates** button and a **Download latest
  installer** link if you'd rather update manually.
- Updates are unsigned too. If Windows asks, use the same **More info → Run
  anyway** step.

If an update ever fails to start, your work is still safe. Download the latest
installer from the release page and run it over the existing installation, or
install the previous version from the same page. Back up first if you're
jumping backwards across several releases.

## Reporting a problem

1. Open **About** in the top bar.
2. Click **Copy diagnostics**. That copies the app version, platform, data and
   log locations, and the last update state — no writing content.
3. Open an issue at **https://github.com/Haibane-Lain/Iwakura-Memoria/issues**
   and paste the diagnostics along with what you were doing.
4. The **Logs** row in About opens the folder with `main.log`; attach it if the
   problem is about starting or updating.

If the app won't open at all, you can still get the data folder at
`%LOCALAPPDATA%\IwakuraMemoria\data` and the logs at
`%LOCALAPPDATA%\IwakuraMemoria\logs`.

## A note on privacy

Iwakura Memoria is local-first. Your projects stay in the data folder, grammar
and Lookup run offline, and the app only contacts GitHub to check for updates.
If you configure Lain, the text you ask it to work on is sent to the provider you
chose, using your key. That is the only time writing leaves your machine.
