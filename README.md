# Ollama Pi Chat

![Cover Image](promo/cover.png)

## A Beautiful, Secure, & Local-First Web Interface for Ollama, Pi, and Cloud Models

Welcome to **Ollama Pi Chat**! This is a local-first desktop wrapper and web application that gives you a gorgeous, retro-brutalist chat interface to interact with local AI models, agent systems, and optional cloud model providers.

The core chat server and desktop wrapper run directly on your macOS machine. **Offline Ollama chat does not require an internet connection.** Pi mode runs through your local Pi CLI. Cloud mode is optional and only contacts the provider you configure. Optional web/MCP/shell skills can contact external services or run local commands only when enabled and invoked, so review those settings before using them with sensitive prompts.

> [!IMPORTANT]
> **macOS Gatekeeper Warning**: The developer of this project does not have a paid Apple Developer Account, so the pre-built desktop applications and binaries are not digitally signed.
> When running the packaged app for the first time, macOS Gatekeeper will block execution or show a warning. Please refer to the [Troubleshooting Common Issues](#-troubleshooting-common-issues) section for simple, standard instructions on how to bypass this.

---

## Table of Contents

1. [What is Ollama Pi Chat?](#what-is-ollama-pi-chat)
2. [The Three Chat Modes Explained](#the-three-chat-modes-explained)
3. [Core Features Tour](#core-features-tour)
4. [Requirements & Downloads](#requirements--downloads)
5. [How to Run & Install (Choose Your Path)](#how-to-run--install-choose-your-path)
6. [Understanding the Settings Panel](#understanding-the-settings-panel)
7. [Database Research From Scratch](#database-research-from-scratch)
8. [Privacy, Security, & Where Data is Stored](#privacy-security--where-data-is-stored)
9. [Troubleshooting Common Issues](#troubleshooting-common-issues)
10. [Pre-publishing Checks (For Developers)](#pre-publishing-checks-for-developers)

---

## What is Ollama Pi Chat?

For non-technical users, think of Ollama Pi Chat as a **private control deck for Artificial Intelligence**. You can keep work fully local with Ollama, use Pi for terminal-grade agent tasks, or intentionally switch to Cloud mode when you want to use your own provider API keys.

It combines **three powerful systems** under one beautiful user interface:

- **Ollama**: An engine that runs massive AI models on your local hardware.
- **Pi**: An agent system that can perform actions (like read files, write files, search local directories, and run terminal scripts).
- **Cloud**: A direct chat mode for provider APIs such as OpenAI, Anthropic Claude, and Mistral.

---

## The Three Chat Modes Explained

You can toggle between the three modes instantly using the icon switch at the top-left of the application bar.

```text
+--------------------------------------------+
| [ Ollama icon ] [ Pi icon ] [ Cloud icon ] |
+--------------------------------------------+
```

### 1. Ollama Mode (Pure Offline Chat)

In Ollama Mode, the app speaks directly to your local Ollama installation.

- **Best for**: Standard chat, brainstorming, editing text, asking general knowledge questions, translating languages, or rewriting documents.
- **How it works**: Select any model you have downloaded (e.g., `llama3`, `mistral`, `phi3`) from the top drop-down menu and type your prompt. It streams the response word-by-word.
- **Reasoning/Thinking Support**: If you select a reasoning model (like `deepseek-r1`) that outputs chain-of-thought processing, the app renders the AI's internal thoughts in a beautiful, collapsible details box so it doesn't clutter your chat history.

### 2. Pi Mode (Agent-Driven Execution)

In Pi Mode, the app acts as a secure bridge to the **Pi agent command-line tool**.

- **Best for**: Complex automation, programming tasks, searching local project folders, reviewing codebase directories, or performing system actions.
- **Interactive Browser Permissions (The Security Guards)**: When Pi runs a tool to modify files, run command terminal lines, or query sensitive folders, it requests permission. Ollama Pi Chat captures this request and pops up a clear, non-technical interactive dialog in your browser. You can **Allow**, **Deny**, input custom variables, or edit the command before it runs. This prevents the command-line tool from silently hanging or executing unauthorized actions on your machine.
- **Live Status**: The title bar can show the active Pi model, state, cost label, and thinking level when your Pi CLI exposes those values through RPC.

### 3. Cloud Mode (Bring Your Own API Key)

In Cloud Mode, the app sends chat requests directly from the local server to the cloud provider you configure.

- **Best for**: Using hosted models when you want higher capacity, a specific provider model, or a fallback when local models are not enough.
- **Supported providers**: OpenAI, Anthropic Claude, and Mistral.
- **How it works**: Open Settings, choose the Cloud provider, paste your API key, set the model id, and save. Then switch to the Cloud icon in the top-left mode selector and chat normally.
- **Privacy note**: Cloud prompts and uploaded text are sent to the selected provider. Use Ollama or Pi mode for workflows that must remain fully local.

---

## Core Features Tour

Ollama Pi Chat is packed with premium, user-friendly utilities:

- **Unified Responsive Design**: Responsive brutalist grid layouts with smooth transitions, customized fonts, and visual hover effects.
- **Native MCP Support**: Full Model Context Protocol (MCP) integration. Click the plug icon to instantly connect local MCP servers (like Memory, Filesystem, or SQLite) directly to your Ollama models.
- **Auto-Saving Notes Panel**: Click the **Notes** icon on the top right to slide open a dedicated notepad. Type notes, cheat sheets, or drafts; the app autosaves them directly to your browser's memory, persisting them even if you refresh the page.
- **Smart File Uploader**: Drag or select documents (like `.txt`, `.md`, `.json`, `.py`, `.js`, `.css`, etc.). The app extracts and loads the text into your prompt box. If you upload a `.pdf` file, the app automatically runs local text extraction utility (`pdftotext`) to ingest it.
- **Local Library Research**: Build a private SQLite index from Calibre EPUB books plus configured TXT or Markdown note folders, then let Ollama retrieve relevant passages before answering.
- **Cloud Mode**: Use OpenAI, Anthropic Claude, or Mistral models with your own API keys while keeping the app UI, history, and settings local.
- **System Prompt Overlays Manager**: Click **Settings** and scroll to "Custom Overlay Prompt" to create templates (like a translation assistant, code reviewer, or copy editor). You can switch between system personalities instantly using the top bar selector.
- **Conversation History**: Reload, manage, or clear past chat sessions from the historical drawer on the left side.
- **Log Auditing**: The application maintains a health log of system start times, timeout issues, and a detailed audit of every permission you granted or denied in Pi mode.



https://github.com/user-attachments/assets/ee4bdb68-7e68-4ccd-9783-31355823e891



---

## Requirements & Downloads

To run this application locally, you will need a few simple components installed on your Mac:

1. **Node.js (Version 20+)**: The engine that hosts the local server. Download the "LTS" version from the official [Node.js Website](https://nodejs.org).
2. **Ollama**: The application that manages and runs AI models. Download it from the [Ollama Website](https://ollama.com).
   - Once installed, open your Mac Terminal application and download a model by running:
     ```bash
     ollama run llama3
     ```
3. **Pi CLI (Only required for Pi Mode)**: The agent execution engine. Make sure the `pi` command is installed and accessible in your environment PATH.
4. **Cloud Provider API Key (Only required for Cloud Mode)**: Bring an API key from OpenAI, Anthropic, or Mistral if you want to use hosted models.
5. **SQLite (Optional - for Local Library Research)**: Keyword database search works with normal SQLite. Semantic vector search requires a SQLite build that can load extensions, the sqlite-vec extension, and a local Ollama embedding model. Apple `/usr/bin/sqlite3` cannot load sqlite-vec because it is built with `OMIT_LOAD_EXTENSION`; install Homebrew SQLite for semantic search.
6. **pdftotext (Optional - for PDF uploads)**: To extract and read PDF uploads, install it via Homebrew:
   ```bash
   brew install poppler
   ```

---

## How to Run & Install (Choose Your Path)

Depending on your technical comfort level, select one of the following methods to start using the app.

---

### Path A: The Simple Startup (Great for Regular Users)

1. Open your Mac **Terminal** application (found in Applications > Utilities).
2. Navigate to the folder where you unpacked this project:
   ```bash
   cd "/path/to/ollama-pi-chat"
   ```
3. Make the launcher script executable (only needed the first time):
   ```bash
   chmod +x run.sh
   ```
4. Run the script:
   ```bash
   ./run.sh
   ```

- **What this does**: The script tests your Node environment, checks if Ollama is running in the background, starts the local server, and automatically opens your web browser to `http://127.0.0.1:8080` where the chat interface is ready to use!

---

### Path B: Install as a macOS Desktop App (`.app`)

If you want a native, clickable Mac app icon in your Dock that behaves like any other program:

1. Open terminal in the project directory and install the necessary helper modules:
   ```bash
   cd "/path/to/ollama-pi-chat"
   npm install
   ```
2. Build the application wrapper:
   ```bash
   npm run build:app
   ```
3. Open the newly created `release` folder:
   - You will find `Ollama Pi Chat.app` inside. You can drag this to your Mac's `Applications` folder!
   - _Note: Since this build is local and unsigned by Apple Developer credentials, the first time you run it, macOS Gatekeeper may warn you. Right-click the app icon and select "Open" to bypass this validation._
4. The Desktop app will automatically launch its server in the background and open the user interface.

---

### Path C: Register as an Always-On Background Service

If you want the Ollama Pi Chat server to start automatically whenever you turn on your Mac (without needing to keep a terminal window open):

1. Compile the standalone binary first (Path D) so it creates the binary at `dist/ollama-pi-chat`.
2. Run the registration script in terminal:
   ```bash
   chmod +x install-launchagent.sh
   ./install-launchagent.sh
   ```

- **How it works**: This creates a macOS LaunchAgent plist at `~/Library/LaunchAgents/com.user.ollamapichat.plist`. The server now boots silently at login and listens securely at `http://127.0.0.1:8080`.
- **To stop the service later**, run:
  ```bash
  launchctl bootout "gui/$UID/com.user.ollamapichat"
  ```
- **To restart the service later**, run:
  ```bash
  launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.user.ollamapichat.plist"
  ```

---

### Path D: Standalone Compilation (For Advanced Users)

You can package Node.js, the local server code, and the frontend web pages into a **single, standalone binary file** with zero external runtime folder dependencies:

1. In the terminal, run:
   ```bash
   chmod +x build-sea.sh
   ./build-sea.sh
   ```
2. **Output**: A single executable binary file at `dist/ollama-pi-chat`.
3. You can copy this executable file anywhere on your Mac and double-click or run it directly:
   ```bash
   ./dist/ollama-pi-chat
   ```

---

## Understanding the Settings Panel

Click the slider icon (**Settings**) in the top right to configure your system. Here is a breakdown of what these settings mean in plain English:

### 1. Appearance & Presets

- **Ollama/Pi/Cloud Color Palette**: Swap between custom-designed color schemes. Different palettes can be set for each mode so you instantly know which mode is active.
- **Ollama/Pi/Cloud Font Family**: Change the typography style of the chat messages. You can use standard monospaced fonts, serif fonts, or type in a custom font installed on your system.

### 2. AI Sampling Sliders (Ollama Generation Options)

These parameters let you control the "personality" and behavior of the local Ollama models:

| Setting                      | What it does                                                                     | Lower Value                                                                                        | Higher Value                                                                                                | Default   |
| :--------------------------- | :------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- | :-------- |
| **Temperature**              | Controls the randomness or creativity of responses.                              | **0.0 - 0.2**: Highly precise, factual, repetitive. Ideal for math, coding, and strict guidelines. | **1.0 - 1.5**: Highly creative, variable, expressive. Ideal for brainstorming or writing fiction.           | **0.3**   |
| **Top P**                    | Nucleus sampling. Filters candidate words based on their cumulative probability. | **0.1**: The model will only choose from the most obvious words.                                   | **0.9**: Allows the model to pick slightly rarer words, making it more interesting.                         | **0.6**   |
| **Top K**                    | Limits the model's vocabulary choice to the _K_ most probable next words.        | **10**: Highly predictable vocabulary.                                                             | **100**: Richer, more diverse vocabulary.                                                                   | **20**    |
| **Repeat Penalty**           | Punishes the model for repeating the exact same phrases.                         | **1.0**: No penalty. Might loop or repeat.                                                         | **1.5**: Strong penalty. Forces the AI to find alternative wording.                                         | **1.15**  |
| **Context Window (num_ctx)** | The AI's short-term memory limit (including prompt and response history).        | **2048**: Fast response times, but forgets earlier details quickly.                                | **32768 - 131072**: Can remember entire uploaded books or long codebases, but consumes more RAM/GPU memory. | **32768** |

### 3. Database

- **Database File**: Chooses where the generated SQLite index is stored. The default is `~/ollama-pi-chat/library.sqlite`.
- **Enable Database Context**: Searches your private SQLite library before sending the prompt to the active chat mode. When this is disabled, Ollama, Pi, and Cloud answer normally without database context. In Cloud mode, retrieved passages are sent to the selected provider.
- **Passages**: Controls how many retrieved chunks are inserted into the model context.
- **Context Chars**: Caps how much retrieved library text is sent to the model.
- **Source Paths**: When enabled, source boxes can copy the local file path. The model does not receive local file paths.
- **Semantic Vector Search**: Enables embedding-based retrieval when sqlite-vec is configured. This is the recommended default for large libraries.
- **Keyword FTS Index**: Optional exact-term fallback search. It increases database size, so leave it off unless you specifically need keyword matching.
- **Embedding Model**: Choose an installed Ollama model for embeddings. `nomic-embed-text-v2-moe:latest` is a good multilingual choice for English and Spanish libraries.
- **Vector Dims**: Controls stored embedding dimensions. The default is `256`, which keeps the index smaller while still using the compact Matryoshka representation from Nomic-style embedding models.
- **Source Folders**: Add, remove, and edit folders from the UI. The default Books source indexes EPUB files only, while note sources can index `.md` and `.txt`.
- **Estimate Index Size**: Samples the configured source folders and estimates final passage count and database size before a full index run.
- **Build / Update Index**: Scans changed source files and updates `library.sqlite`. It also repairs missing embeddings for unchanged files, so a temporary embedding failure can be retried without re-reading every EPUB.
- **Retry Embeddings**: Scans the existing index for passages missing embedding/vector rows and retries them. This is useful after Ollama, sqlite-vec, or the embedding model temporarily failed.
- **Reindex All**: Rebuilds every configured source even if the file did not change.
- **Export Indexed Files**: Writes a plain text list of indexed EPUB files to `~/ollama-pi-chat/indexed-epub-files.txt` and reveals the file in Finder.
- **Pause Index**: Pauses the running index job between files or embedding batches. A paused job will not auto-resume until you start indexing again.

### 4. Pi Configuration Settings

- **Pi Command Path**: If your system has multiple installations of the Pi tool, you can paste the exact file path here (e.g., `/usr/local/bin/pi`).
- **Pi Working Directory**: The default directory where Pi runs code. By default, this is set to your storage directory.
- **Pi Timeout**: If Pi halts or waits on a task, this defines how long the system waits before automatically terminating the session.
- **Permission Policy**:
  - **Normal**: Prompts you for critical operations but automates standard lookups.
  - **Strict**: Hard-blocks root access, shortens decision timers, and prompts you for everything to ensure maximum security.

### 5. Built-in Agent Skills (Ollama)

Ollama Pi Chat comes with a suite of native tools that you can toggle on or off in the settings. When enabled, your local Ollama models can automatically invoke these skills to perform actions or look up real-time information:

- **Wikipedia**: Searches Wikipedia for factual information and summaries. Requires internet access.
- **Britannica**: Searches the Encyclopedia Britannica for curated facts. Requires internet access.
- **Wiktionary**: Looks up deep dictionary definitions. Requires internet access.
- **Deep Etymology**: Cross-references multiple multilingual etymological dictionaries (Etymonline, RAE, CNRTL, DeChile) to find word origins, cognates, and false friends. Requires internet access.
- **DuckDuckGo**: Performs general, privacy-respecting web searches for recent news and events. Requires internet access.
- **Web Scraper**: Extracts raw, readable text content from any provided web URL. Requires internet access.
- **Calculator**: Securely evaluates complex mathematical expressions.
- **Time & Date**: Retrieves the current local time, date, and day of the week, with support for global IANA timezones (e.g., `Australia/Sydney`).
- **Fact Check**: Fact-checks specific claims against multiple sources. Requires internet access.
- **Shell Command**: Executes bash terminal commands directly from the chat (requires explicit interactive confirmation for safety). Custom shell skills use the same confirmation gate.
- **Local Notes**: Allows the model to directly read from or append text to your persistent local notes file.

### 6. Cloud Mode Settings

- **Provider**: Choose OpenAI, Anthropic Claude, or Mistral.
- **API Key**: Paste your provider key. Keys are saved on disk by the local server and are never returned to the browser UI after saving.
- **Model**: Enter the exact model id you want to use for that provider.
- **Base URL**: Keep the provider default unless you use a compatible gateway or proxy.
- **Max Output Tokens**: Caps the maximum response length requested from the provider.

### 7. MCP (Model Context Protocol) Integration

Ollama Pi Chat fully supports connecting external **MCP Servers** to your local Ollama models.
Click the **Plug Icon** in the top title bar to open the MCP Panel. You can paste standard `mcpServers` JSON configuration directly into the box. The app will automatically parse your config, spin up the external servers in the background, map their tools, and dynamically render sleek plain-English badges (like `MEMORY`, `FILESYSTEM`) below the editor so you always know what tools are locked and loaded.

---

## Database Research From Scratch

The Database feature lets Ollama, Pi, and Cloud modes answer with passages retrieved from your own local files. It is not automatic until you configure sources, build the index, and turn on Database Context. The generated index lives in SQLite, usually at `~/ollama-pi-chat/library.sqlite`. In Cloud mode, retrieved passages are sent to the selected provider with your prompt.

### What the Database Does

1. Reads configured source folders.
2. Extracts text from supported files.
3. Splits the text into searchable passages.
4. Stores compressed passage text and metadata in SQLite.
5. Creates embeddings for semantic vector search when enabled.
6. Optionally creates a lightweight FTS5 keyword index when enabled.
7. Retrieves relevant passages before a chat request.
8. Injects those passages into the active model prompt with source information.

When **Enable Database Context** is off, none of this retrieval context is added and the active mode answers normally.

### First-Time Setup

1. Open the app.
2. Open **Settings**.
3. Find the **Database** section with the database icon.
4. Confirm **Database File**. The default is:
   ```text
   ~/ollama-pi-chat/library.sqlite
   ```
5. Under **Source Folders**, add one row per folder you want indexed.
6. For a Calibre EPUB library, use:
   ```text
   Name: Books
   Type: book
   Folder Path: ~/Libros
   Extensions: .epub
   ```
7. For Obsidian or notes, add a separate source:
   ```text
   Name: Obsidian
   Type: note
   Folder Path: /path/to/your/Obsidian/vault
   Extensions: .md, .txt
   ```
8. Turn on **Enable Semantic Vector Search** if sqlite-vec and your embedding model are ready.
9. Leave **Enable Keyword FTS Index** off unless you need exact-term fallback search.
10. Click **Save Database Settings**.
11. Click **Estimate Index Size** to preview projected passage count and database size.
12. Click **Build / Update Index**.
13. Watch the progress bar and status line until indexing completes.
14. Turn on **Enable Database Context**.
15. Ask normally in Ollama, Pi, or Cloud mode. Use Cloud only when you are comfortable sending the retrieved passages to that provider.

### What Gets Indexed

- Calibre EPUB books are indexed from `.epub` files.
- Markdown notes can be indexed from `.md` files.
- Plain text notes can be indexed from `.txt` files.
- Calibre `metadata.opf` is not indexed as content. It is only used as fallback title/author metadata.
- `cover.jpg`, cover images, EPUB images, PDFs, and standalone image files are not indexed.
- Image-only comics and EPUBs with too little extractable text are skipped and reported as skipped documents.

The indexer only reads your source files. It does not edit, convert, rename, or delete your books or notes.

### Search Modes

**Keyword Search**

Keyword search uses SQLite FTS5. It does not require embeddings or sqlite-vec, but it increases `library.sqlite` because SQLite must store a keyword index for the passage text. It is useful for exact names, titles, words, and phrases. For very large EPUB libraries, leave **Enable Keyword FTS Index** off unless you need exact-term fallback search.

**Semantic Vector Search**

Semantic search uses embeddings and sqlite-vec. It is the recommended mode for large personal libraries because it can stay compact and is better when your question and the book use different words for the same idea. For example, a question like `What did Freud say about incest?` may need passages containing `tabu del incesto`, `Oedipus complex`, `Totem and Taboo`, or related Spanish terms.

**Compact Storage**

The index stores passage text compressed in SQLite. The model still receives normal readable passages at chat time, but the database does not keep a large plain-text copy of every passage. Keyword FTS is optional because it adds a second search structure.

### SQLite and sqlite-vec Setup

This section matters if you want **Semantic Vector Search**, which is recommended for large libraries. If you only want optional keyword FTS search, you can leave semantic search off and skip these steps.

There are two different pieces involved:

- **SQLite**: The database program that stores and searches the index.
- **sqlite-vec**: The extension that adds vector search to SQLite.

macOS includes SQLite at:

```text
/usr/bin/sqlite3
```

That Apple SQLite is fine for basic SQLite work, but it cannot load sqlite-vec. It is built with:

```text
OMIT_LOAD_EXTENSION
```

If semantic search tries to use Apple SQLite, you may see an error like:

```text
unknown command or invalid arguments: "load"
```

That means the wrong SQLite binary is being used. The fix is to install Homebrew SQLite and use the official sqlite-vec Python package.

#### Step 1: Install Homebrew SQLite

Open Terminal and run:

```bash
brew install sqlite
```

Homebrew may say SQLite is already installed. That is fine.

The app looks for Homebrew SQLite here:

```text
/opt/homebrew/opt/sqlite/bin/sqlite3
```

On older Intel Macs, Homebrew may use:

```text
/usr/local/opt/sqlite/bin/sqlite3
```

The app checks these Homebrew paths before Apple `/usr/bin/sqlite3`.

To verify Homebrew SQLite exists, run:

```bash
/opt/homebrew/opt/sqlite/bin/sqlite3 -version
```

If that command prints a SQLite version, the SQLite side is ready.

#### Step 2: Install sqlite-vec Safely

Do not download a random `vec0.dylib` manually from a browser unless you know exactly where it came from. The recommended path is to install the official `sqlite-vec` Python package inside a virtual environment.

First create a small isolated Python environment:

```bash
python3 -m venv ~/sqlite-vec-env
```

Activate it:

```bash
source ~/sqlite-vec-env/bin/activate
```

Install sqlite-vec:

```bash
pip install sqlite-vec
```

Find the installed `vec0.dylib` path:

```bash
python -c "import sqlite_vec, pathlib; print(pathlib.Path(sqlite_vec.__file__).parent / 'vec0.dylib')"
```

The output will look similar to:

```text
/Users/your-name/sqlite-vec-env/lib/python3.14/site-packages/sqlite_vec/vec0.dylib
```

Copy the exact path printed by your Terminal.

#### Step 3: Paste the Path Into the App

Open the app:

1. Go to **Settings**.
2. Go to **Database**.
3. Turn on **Enable Semantic Vector Search**.
4. Paste the `vec0.dylib` path into **SQLite-Vec Extension Path**.
5. Choose your embedding model.
6. Keep **Vector Dims** at `256` unless you have a specific reason to use larger vectors.
7. Click **Save Database Settings**.
8. Click **Reindex All**.

Use the path printed on your own machine. Do not copy another user's path.

To enable semantic search:

1. Install Homebrew SQLite.
2. Install sqlite-vec in a Python virtual environment.
3. In **Settings > Database**, turn on **Enable Semantic Vector Search**.
4. Set **SQLite-Vec Extension Path** to the `vec0.dylib` file from the virtual environment.
5. Choose an **Embedding Model** from the dropdown.
6. Keep **Vector Dims** at `256` unless you have a specific reason to store larger vectors.
7. For English and Spanish libraries, `nomic-embed-text-v2-moe:latest` is recommended if it is installed in Ollama.
8. Click **Save Database Settings**.
9. Click **Reindex All** so embeddings are generated for every passage.

If semantic search is enabled but sqlite-vec or Ollama embeddings are not available, the app still stores compressed passages but cannot perform semantic retrieval. Turn on **Enable Keyword FTS Index** only if you want keyword fallback. The index status shows the embedding preflight error instead of silently leaving embeddings at zero.

The indexer stores compressed passage text. If keyword FTS is enabled, it creates a separate lightweight FTS5 keyword index. The app also compacts the SQLite file after an index run so old deleted pages are returned to disk.

If you previously built an older plain-text/FTS-heavy database, create a fresh compact index. Pause any active index job, quit the app, delete the old `~/ollama-pi-chat/library.sqlite` file, reopen the app, run **Estimate Index Size**, then run **Build / Update Index**. The old database format will still be readable, but it will not become compact until files are reindexed.

### Embedding Model Dropdown

The dropdown is populated from your installed Ollama models. If your embedding model is not listed, pull it first in Terminal, for example:

```bash
ollama pull nomic-embed-text-v2-moe:latest
```

Then reopen or refresh the app. You can also choose **Custom model id** and type the exact model name.

Changing the embedding model requires **Reindex All**. Old embeddings were created with the previous model and should not be mixed with a new embedding model.

### Indexing Buttons

- **Estimate Index Size**: Samples configured source files and estimates passage count, compressed text size, vector size, and projected total database size. Use this before indexing thousands of books.
- **Build / Update Index**: Scans configured sources and indexes only new or changed files.
- **Retry Embeddings**: Retries missing embedding/vector rows without forcing every EPUB to be re-extracted.
- **Reindex All**: Processes every configured file again. Use this after changing the embedding model, enabling semantic search, changing sqlite-vec, enabling/disabling keyword FTS, or changing chunking/search assumptions.
- **Refresh Status**: Reloads the database status, including file count, passage count, embedding count, source count, and whether sqlite-vec is active.
- **Export Indexed Files**: Writes `~/ollama-pi-chat/indexed-epub-files.txt`, a plain text report of every indexed EPUB path, title, author, passage count, and index date, then reveals the file in Finder.
- **Pause Index**: Requests a pause. If the job is compacting SQLite, the pause waits until the current database operation finishes.

Large libraries can take a long time on the first run. A library with thousands of EPUBs may take hours depending on EPUB quality, disk speed, and whether embeddings are enabled. If you close the app while indexing, the local server process stops and the active batch is interrupted. The app writes the job state to `~/ollama-pi-chat/library-index-job.json`, and on the next launch it automatically resumes a job that was still marked as running. If you press **Pause Index**, the job is marked as paused and will not auto-resume until you start indexing again.

**Embed Errors** are final embedding failures after automatic retries. They are separate from **Skipped docs**. Skipped docs are usually files that could not produce enough readable text, such as image-only comics or malformed EPUBs. Embedding errors are written to `~/ollama-pi-chat/library-index-errors.jsonl` with the file path, chunk ids, and error message. The Settings database panel also shows recent issues while the job is running.

For compactness, the database stores full retrieved passages, but semantic embeddings are generated from a shorter head/tail excerpt of long passages. This avoids Ollama embedding-model context-length failures without increasing the number of stored passages.

### Asking Questions With Sources

For source-grounded answers:

1. Make sure the index exists and status shows files/passages.
2. Turn on **Enable Database Context**.
3. Keep **Include Source Paths in Source Boxes** enabled if you want source buttons to copy local paths.
4. Set **Passages** to `5` or `8`.
5. Ask a direct question, for example:
   ```text
   What did Freud say about incest?
   ```

The app retrieves passages, sends them to the active model as temporary context, and asks the model to use those passages only when relevant. The model receives title, author, heading, and passage text, but not local file paths. The app renders retrieved sources as separate source buttons below the assistant response; clicking a source copies the local path when source paths are enabled. Source boxes are saved with the assistant message and remain visible when switching modes or reloading a conversation.

### Slash Commands

Slash commands are optional overrides. If you do not type a slash command, normal behavior is unchanged: Ollama can still decide to call enabled skills automatically, and Database Context follows the Settings toggle.

- `/db question`: Global database-only mode for Ollama, Pi, and Cloud. This forces a database search for that prompt, even if Database Context is off, and instructs the model to answer only from retrieved passages.
- `/wiki query`: Force Wikipedia in Ollama mode.
- `/britannica query`: Force Britannica in Ollama mode.
- `/wiktionary word`: Force Wiktionary in Ollama mode.
- `/etymology word`: Force Deep Etymology in Ollama mode.
- `/duckduckgo query`: Force DuckDuckGo search in Ollama mode.
- `/scrape URL`: Force Web Scraper in Ollama mode.
- `/calc expression`: Force Calculator in Ollama mode.
- `/time timezone`: Force Time & Date in Ollama mode. The timezone is optional.
- `/factcheck claim`: Force Fact Check in Ollama mode.
- `/notes read` or `/notes append text`: Force Local Notes in Ollama mode.
- `/shell command`: Force Shell Command in Ollama mode. It still requires explicit confirmation.

For language-sensitive commands, prefix the query with `en:`, `es:`, or `fr:` when useful, for example `/wiki es: Nijinsky` or `/etymology es: eventualmente`.

### Mode Support

Database retrieval is wired into Ollama, Pi, and Cloud modes. Ollama and Pi keep the retrieved passages local. Cloud mode sends retrieved passages to the selected cloud provider, so leave **Enable Database Context** off in Cloud mode when you do not want private excerpts sent externally.

---

## Privacy, Security, & Where Data is Stored

Ollama Pi Chat is designed from the ground up to respect your digital sovereignty.

### Data Storage Locations

- **Local Storage Directory**: By default, all backend configuration and logs are kept in:
  ```
  /Users/your_username/ollama-pi-chat/
  ```
  Inside this folder, you will find:
  - `conversations.json`: Your entire chat history, locally cached.
  - `prompts.json`: Your custom overlay prompts.
  - `ui-settings.json`: Mode-specific palettes and font settings.
  - `cloud-settings.json`: Cloud provider settings and saved API keys. This file is written with owner-only permissions (`0600`) when possible.
  - `library-config.json`: Local Library Research source paths, search limits, and optional embedding settings.
  - `library-index-job.json`: Last index job state. This is used to auto-resume interrupted running jobs after reopening the app.
  - `library-index-errors.jsonl`: Structured index issue log with embedding failures, skipped documents, and file-level index errors.
  - `library.sqlite`: Generated local library database containing compressed indexed passages, optional embeddings, and optional keyword FTS data.
  - `indexed-epub-files.txt`: Plain text export created by **Export Indexed Files** in Settings > Database.
  - `security-events.jsonl`: The security audit trace showing permission requests and execution logs.
  - `daemon.log` / `daemon.error.log`: Output logs when running the LaunchAgent background daemon.
- **Browser localStorage**: Browser-side fallbacks, active prompt selection, and some UI state are saved in the browser's sandbox storage (`localStorage`). Clearing your browser cache or storage may reset browser-only UI state.

### Cloud Mode Privacy

Cloud mode is intentionally not local-only. When you use Cloud mode, prompts, uploaded file text, and conversation context for that request are sent to the selected provider API. API keys are stored locally in `~/ollama-pi-chat/cloud-settings.json` or can be supplied through environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `MISTRAL_API_KEY`).

### Network Safety Protections

The local Node.js server implements active security headers to protect your local system from web-based attacks:

1. **Origin Verification**: The server automatically rejects any inbound HTTP request whose `Host` or `Origin` header does not match the active local server port on `127.0.0.1` or `localhost`. This prevents malicious websites you visit in other tabs from talking to your local AI server.
2. **CSP (Content Security Policy)**: Blocks execution of injected scripts and strictly restricts style sheet, font, and connect sources.
3. **MIME Sniffing & Framing Protections**: Anti-clickjacking headers are applied to prevent the local chat interface from being framed by external sites.
4. **Root Block**: The server will immediately shutdown and refuse to boot if started as the root administrator user (`UID 0`).

---

## Troubleshooting Common Issues

### Error: `listen EADDRINUSE 127.0.0.1:8080`

- **What it means**: The network port `8080` is already occupied. This usually happens if an old instance of the Ollama Pi Chat server is still running in the background, or another application (like a development project) is using that port.
- **How to fix it**:
  1. Open terminal and find the process ID (PID) occupying the port:
     ```bash
     lsof -nP -iTCP:8080 -sTCP:LISTEN
     ```
  2. Kill the process (replace `<PID>` with the actual process number from step 1):
     ```bash
     kill -9 <PID>
     ```
  3. Alternatively, you can open `server.js` and change `DEFAULT_PORT = 8080` to an open port (e.g., `8082`).

### Models are not showing up in the selector

- **What it means**: Ollama Pi Chat cannot establish a connection with the local Ollama engine.
- **How to fix it**:
  1. Make sure the Ollama application is launched and running on your Mac.
  2. Check if Ollama is accessible by opening this URL in your web browser: [http://localhost:11434/api/tags](http://localhost:11434/api/tags).
  3. If you get a connection error, restart Ollama. If you get a blank list, open terminal and pull a model:
     ```bash
     ollama pull llama3
     ```

### PDF uploads are failing

- **What it means**: Your system is missing the text extractor utility.
- **How to fix it**:
  - Open terminal and install `poppler` (which contains `pdftotext`):
    ```bash
    brew install poppler
    ```
  - Confirm it is installed by running `which pdftotext`.

### Pi Mode hangs when I run a command

- **What it means**: Pi CLI is not installed or the permission prompt is waiting.
- **How to fix it**:
  1. Confirm the Pi tool is available by running `which pi` in terminal. If missing, check your Pi CLI setup path.
  2. Ensure the permissions extension (`@gotgenes/pi-permission-system`) is properly registered in your Pi runtime configurations.

### Cloud Mode says the API key is missing

- **What it means**: No key is saved for the selected provider, and no matching environment variable is available to the server.
- **How to fix it**:
  1. Open **Settings** and switch to the Cloud Mode section.
  2. Choose your provider, paste the API key, confirm the model id, and click **Save Cloud Settings**.
  3. Alternatively, start the server with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `MISTRAL_API_KEY` set in the environment.

### Local Library Research shows zero files

- **What it means**: The indexer has not found readable EPUB, TXT, or Markdown files in the configured source folders.
- **How to fix it**:
  1. Open `~/ollama-pi-chat/library-config.json` and confirm your source paths exist.
  2. Confirm your DRM-free EPUB books are in the configured books folder, for example `~/Libros`. Calibre `metadata.opf`, cover images, PDFs, and image-only comics are not indexed as content.
  3. Run:
     ```bash
     npm run library:index
     npm run library:status
     ```
  4. If semantic search is enabled, confirm your embedding model is available in Ollama and that `embedding.sqliteVecExtensionPath` points to a valid sqlite-vec extension file.

### Semantic search says `unknown command or invalid arguments: "load"`

- **What it means**: The app is trying to load sqlite-vec with a SQLite binary that does not support loadable extensions. On macOS, Apple `/usr/bin/sqlite3` is built with `OMIT_LOAD_EXTENSION`, so it cannot load `vec0.dylib`.
- **How to fix it**:
  1. Install Homebrew SQLite:
     ```bash
     brew install sqlite
     ```
  2. Confirm Homebrew SQLite exists:
     ```bash
     /opt/homebrew/opt/sqlite/bin/sqlite3 -version
     ```
  3. Quit and reopen the app. The app automatically prefers `/opt/homebrew/opt/sqlite/bin/sqlite3` when it exists.
  4. Confirm **Settings > Database > SQLite-Vec Extension Path** points to the official `vec0.dylib` installed from `sqlite-vec`.
  5. Click **Reindex All**.

### `pip install sqlite-vec` says `externally-managed-environment`

- **What it means**: Your Python is managed by Homebrew or macOS, and Python is blocking direct package installation into that shared environment.
- **How to fix it**: Use a virtual environment:
  ```bash
  python3 -m venv ~/sqlite-vec-env
  source ~/sqlite-vec-env/bin/activate
  pip install sqlite-vec
  python -c "import sqlite_vec, pathlib; print(pathlib.Path(sqlite_vec.__file__).parent / 'vec0.dylib')"
  ```
  Paste the printed `vec0.dylib` path into **Settings > Database > SQLite-Vec Extension Path**.

### macOS says Apple cannot verify `vec0.dylib`

- **What it means**: macOS Gatekeeper has quarantined the downloaded dynamic library. This can happen when a `.dylib` is downloaded through a browser.
- **Recommended fix**: Do not use a random browser-downloaded `vec0.dylib`. Install sqlite-vec through the Python virtual environment steps above, then use the `vec0.dylib` path printed by Python.
- **If you still see the warning for a known official file**: You can remove the quarantine attribute only after you are comfortable with the file source:
  ```bash
  xattr -d com.apple.quarantine "/path/to/vec0.dylib"
  ```

### "Ollama Pi Chat is damaged and cannot be opened" / macOS Gatekeeper Blocks App

- **What it means**: The developer of this project does not have a paid Apple Developer Account, so the packaged applications and binaries are unsigned. On newer macOS versions, Gatekeeper will automatically flag and block unsigned apps downloaded from the internet.
- **How to fix it**:
  1. Open your terminal application.
  2. Strip the quarantine attribute from the app (replace the path with where you moved the app, typically in Applications):
     ```bash
     xattr -cr "/Applications/Ollama Pi Chat.app"
     ```
  3. Alternatively, right-click (or Control-click) the application icon in Finder, select **Open**, and click **Open** on the dialog to confirm the exception.

---

## Pre-publishing Checks (For Developers)

Before committing modifications or publishing this folder to a shared repository:

1. **Clean Local Logs**: Ensure generated conversation lists or security events in `~/ollama-pi-chat` are not added to git history. The standard `.gitignore` file already excludes build folders and local storage.
2. **Remove Personal Paths**: Do not hardcode specific system paths (e.g., `/Users/your_name/`) or local developer API tokens.
3. **Verify Signatures**: If code modifications are made, SEA injection blobs must be compiled using thin mach-O binaries so codesign validation checks match. Run the clean export rsync command:
   ```bash
   mkdir -p "/path/to/ollama-pi-chat-github"
   rsync -a --delete \
     --exclude '.git' \
     --exclude 'node_modules' \
     --exclude 'release' \
     --exclude 'dist' \
     --exclude '.DS_Store' \
     --exclude '*.log' \
     --exclude '*.pid' \
     "/path/to/ollama-pi-chat/" "/path/to/ollama-pi-chat-github/"
   ```
