---
name: reproflow
description: Run saved browser flows and capture debug evidence for this project's web app. Use before writing any Playwright, Selenium or pyautogui script.
---
1. Run `reproflow list` and pick a flow that matches the task.
2. Run it: `reproflow run <name> --<param>=<value>`. Read the JSON digest.
3. Open screenshot or snapshot files only if the digest is not enough.
4. No matching flow? Reproduce with `reproflow do <action>` steps, then `reproflow save <name> --from-session`.
5. After fixing code, rerun the same flow to verify the fix.
6. If you get auth_expired, ask the user to run `reproflow login <url>`.
