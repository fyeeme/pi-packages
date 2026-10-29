# pi-timezone-model

Pick the pi session model by wall-clock time.

| Beijing time (UTC+8) | Model |
|---|---|
| before 14:18:00 | `zai-coding-cn/glm-5.3-flash` |
| 14:18:00 and later | `zai-coding-cn/glm-5.3-auto` |

## Behavior

- The rule runs on `session_start` and before every agent run, so a session left open across the cutoff switches on the next message.
- Switching is idempotent: no `model_change` entry is appended when the current model already matches the rule.
- A successful switch (or a missing model) is reported through one `ui.notify` line.
- Manual `/model` picks are overridden on the next prompt — both enabled models are governed by the rule, so this is intentional.

## Install

```bash
ln -s /path/to/pi/packages/extensions/pi-timezone-model ~/.pi/agent/extensions/pi-timezone-model
```

Beijing time has no daylight saving time, so a plain UTC+8 offset is exact year-round; the host timezone setting is irrelevant.
