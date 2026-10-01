# local-conversion-proxy

OpenAI Codex の既定の OpenAI 経路はそのままに、Claude（Anthropic 公式の Claude Code CLI を、使う人自身のログインで動かす）とローカルの Ollama モデルを、GPT と同じモデル一覧で使えるようにする、個人用の実験的なローカルプロキシです。

An experimental, personal local proxy that lets OpenAI Codex use Claude (through the official Claude Code CLI, signed in with your own account) and local Ollama models next to its GPT models.

## 注意 / Notes

- 非公式のツールです。OpenAI・Anthropic とは関係ありません。
  Unofficial; not affiliated with OpenAI or Anthropic.
- Claude は公式の Claude Code CLI を、使う人自身のログインで動かします。利用はその人の契約プランの利用枠から引かれます。
  Claude runs through the official Claude Code CLI with your own sign-in, and counts against your own plan's usage limits.
- 各サービスの利用規約に従い、自己責任で使ってください。サポートはありません。
  Follow each service's terms and use it at your own risk. No support is provided.

## License

MIT. `src/data/codex-base-instructions.md` comes from the OpenAI Codex CLI (Apache License 2.0); see `THIRD_PARTY_NOTICES.md`.
