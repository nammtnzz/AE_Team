---
name: iw-imagegen
description: Generate or edit raster images through a configurable OpenAI-compatible image endpoint. Use whenever the user asks to create, generate, draw, render, mock up, or edit a bitmap image (preview images, concept art, product or website assets, mockups, icons, illustrations). Trigger on requests like "tạo ảnh", "vẽ ảnh", "generate an image", "make me a picture of...", "edit this image", "sửa ảnh này".
metadata:
  short-description: Generate images through a configurable API
---

# IW ImageGen

Use this skill whenever the user wants an image generated or an existing image edited, through the API route configured for this skill. Treat requests phrased in Vietnamese or English the same way ("tạo ảnh...", "vẽ...", "generate an image of...", "edit this photo...").

The bundled CLI at `scripts/image_gen.py` is the primary execution path. It reads:

- Base URL: `OPENAI_BASE_URL` from the process environment, falling back to the skill-local `.env` file
- Model: `IMG_MODEL` from this skill's `.env` file; it is independent of the Claude Code conversation model
- API key source: `OPENAI_API_KEY` from the process environment, falling back to this skill's `.env` file

Do not ask the user to paste an API key in chat. Read `OPENAI_API_KEY` from the process environment first, then from the skill-local `.env` file. If it is missing or invalid in both places, ask the user to set it locally and confirm when ready.

## Model Isolation

- Use `IMG_MODEL=gpt-image-2.5-sunburst` from the skill-local `.env` for image generation and editing.
- Pass `--model gpt-image-2.5-sunburst` on every normal `generate` or `edit` invocation so the image request is explicit and cannot inherit the Claude conversation model.
- Use a different `--model` only when the user explicitly requests a one-run image-model override.

## Workflow

1. Treat ordinary requests as new image generation unless the user clearly asks to edit an existing image.
2. Build a concise structured prompt using the guidance in `references/prompting.md`.
3. Run `scripts/image_gen.py` directly from this skill folder (absolute path shown below).
4. Save final user-facing images into the current project/task output directory, using stable descriptive filenames.
5. Inspect generated images before finishing (read the file back or check size/dimensions), checking that the file is nonblank and matches the prompt.
6. Report the saved path, the model, and the prompt used.

For shared prompting guidance, read [references/prompting.md](references/prompting.md). For prompt recipes, read [references/sample-prompts.md](references/sample-prompts.md) only when examples would help.

## CLI Usage

This skill lives in the current user's Claude skills folder: `%USERPROFILE%\.claude\skills\iw-imagegen` (PowerShell `$env:USERPROFILE\.claude\skills\iw-imagegen`, bash `$HOME/.claude/skills/iw-imagegen`). Always invoke the script with that absolute path so it works regardless of the current working directory.

Generate an image (PowerShell):

```powershell
python "$env:USERPROFILE\.claude\skills\iw-imagegen\scripts\image_gen.py" generate `
  --model "gpt-image-2.5-sunburst" `
  --prompt "Use case: stylized-concept`nAsset type: preview image`nPrimary request: a quiet futuristic reading room at night`nConstraints: no logos, no watermark, no readable text" `
  --size 1024x1024 `
  --quality medium `
  --out "outputs\reading-room.png"
```

Generate an image (bash / git-bash):

```bash
python "$HOME/.claude/skills/iw-imagegen/scripts/image_gen.py" generate \
  --model "gpt-image-2.5-sunburst" \
  --prompt "Use case: stylized-concept
Asset type: preview image
Primary request: a quiet futuristic reading room at night
Constraints: no logos, no watermark, no readable text" \
  --size 1024x1024 \
  --quality medium \
  --out "outputs/reading-room.png"
```

Edit an existing image:

```bash
python "$HOME/.claude/skills/iw-imagegen/scripts/image_gen.py" edit \
  --model "gpt-image-2.5-sunburst" \
  --image "input.png" \
  --prompt "Change only the background to a rainy neon city at night; keep the subject unchanged; no text; no watermark" \
  --out "outputs/edited.png"
```

The script reads its default image model from `IMG_MODEL` in the skill-local `.env` file. This does not affect the Claude conversation model. The skill's normal commands make the image model explicit with `--model gpt-image-2.5-sunburst`; use another `--model` only for an explicit one-run override. Set `OPENAI_BASE_URL` in the process environment or the skill-local `.env` file to change endpoints.

## Practical Notes

- Set `OPENAI_BASE_URL` to the root API URL, not the full `/images/generations` path. The OpenAI SDK appends the endpoint path.
- If inherited proxy variables such as `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` point to a blocked local proxy, clear them for the generation process before retrying.
- Model capabilities vary by endpoint. Use only sizes, transparency options, and edit controls supported by the configured model.
- Do not modify `scripts/image_gen.py` during normal image generation. Patch it only when intentionally updating this skill.
- Requires Python with the `openai` and `Pillow` packages installed (already available in this environment).
