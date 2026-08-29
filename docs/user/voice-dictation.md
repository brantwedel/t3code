# Voice Dictation

Voice dictation records from the message composer and streams your speech into the draft as you
talk. Transcription runs on the connected T3 Code server with a local whisper model — audio never
leaves your machines, and no API key is needed.

Enable it in **Settings** → **General** → **Voice dictation**, pick a model, and download it once.
The model is stored on the server, so every device connected to that server can dictate with it.

The composer then shows a microphone action. Tap it to start listening; the live transcription
appears in the draft and keeps refining itself as you speak. Words land wherever the cursor is, so
you can click into the middle of a draft and carry on dictating there. Pausing for about a second
finalizes the sentence, and the next one starts automatically. Tap the action again to stop.

Hold the microphone instead of tapping it to talk only while you hold — releasing stops listening.

Typing or clicking into the draft hands it back to you: the sentence in progress is dropped rather
than rewritten under your edit, and the next thing you say starts from wherever the cursor ended up.

## Voice commands

Some phrases act instead of being typed. A phrase only counts when it **ends** a sentence, so
ordinary dictation is unaffected — "send the report to Dana" types normally.

A command that could cost you something if it were misheard — sending, removing text, leaving the
draft — **counts down** first, staying visible in the draft while it does. Keep talking and it is
taken back and treated as ordinary words. Commands that cost nothing, like moving the cursor or
breaking a line, act at once. Either behaviour can be changed per command in settings.

| Say                                        | What happens                                 |
| ------------------------------------------ | -------------------------------------------- |
| "send message", "send it"                  | Sends the draft. Dictation keeps listening.  |
| "clear message", "scratch that"            | Empties the draft                            |
| "undo that", "redo that"                   | Steps the composer's own undo history        |
| "new line", "new paragraph"                | Breaks the line                              |
| "go to start", "go to end"                 | Moves the cursor                             |
| "previous line", "next line"               | Moves the cursor a line                      |
| "delete line", "clear line"                | Removes the line the cursor is on            |
| "delete sentence"                          | Removes the sentence the cursor is in        |
| "delete last sentence"                     | Removes the final sentence of the draft      |
| "next chat", "previous chat", "new thread" | Moves between threads, as `⇧⌘]` and `⇧⌘[` do |
| "open command palette"                     | Opens the command palette                    |
| "stop dictation", "stop listening"         | Stops listening                              |

Filler words are ignored on both sides, so "clear a message" works as well as "clear message", and
words said as one or two — "goto" and "go to" — are treated the same.

"Next chat" and "previous chat" step through the sidebar the same way their keyboard shortcuts do,
so "next" moves down the list and "previous" moves up. Swap the two phrases in settings if you would
rather they followed the order you visited threads in.

### Customizing

**Settings** → **General** → **Voice dictation** → **Customize** edits every command: change its
phrases (separate alternatives with commas), or switch it between acting immediately and counting
down. Clearing a command's phrases turns it off without forgetting you configured it.

Two kinds can be added:

- **Replacements** type text you choose when you say a phrase — useful for boilerplate you dictate
  often.
- **App commands** run anything the keyboard can, so a phrase can toggle the sidebar, run a project
  script, or jump between threads. These count down by default, since a misheard phrase would
  otherwise act on its own.

## Models

| Model | Size   | Character                        |
| ----- | ------ | -------------------------------- |
| Tiny  | 75 MB  | Fastest, least accurate          |
| Base  | 142 MB | Recommended balance              |
| Small | 466 MB | Most accurate, needs more memory |

Larger models transcribe more accurately but use more memory and CPU on the server while you
dictate. The model unloads on its own after ten minutes of silence.

## Requirements

- The browser needs microphone access, which requires HTTPS or localhost. When connecting to a dev
  server over a plain-HTTP LAN address, dictation reports that it needs a secure context.
- A brief drop in the connection — a reconnect, or moving between Wi-Fi and cellular — does not end
  dictation. The microphone stays open for about five seconds and what you say during the gap is
  transcribed once the server answers again. A longer outage stops the microphone.
- The connected server must run on macOS, Linux, or Windows on a build that includes the
  transcription engine. Settings shows a note when the environment cannot transcribe.

## Language

The bundled models are English-only. The language field under **Settings** → **General** →
**Voice dictation** is a hint for future multilingual models; leave it empty for now.
