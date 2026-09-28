---
name: Bug report
about: Something in Cold Open does not work the way it says it does
title: "[bug] "
labels: bug
assignees: ""
---

<!--
If a preview site says something untrue about a real business, press "Remove this preview"
on that page first, then file this report so we can fix the cause.
Please do not paste API keys, webhook secrets or personal contact details.
-->

### What happened

A clear description of the bug.

### What you expected

What should have happened instead.

### Steps to reproduce

1. Go to ...
2. Press ...
3. See ...

### Where

- [ ] Mission Control (dashboard)
- [ ] A preview site (`/s/:id`)
- [ ] Checkout or `/claimed`
- [ ] API (`/api/*`)
- [ ] WebSocket / live updates
- [ ] Deploy or setup

Business id or preview URL, if relevant:

### Which agent, if any

- [ ] Scout
- [ ] Archivist
- [ ] Builder
- [ ] Critic
- [ ] Director
- [ ] Closer
- [ ] CFO

### Environment

- Deployment: public demo / my own deployment
- Integrations enabled (from `GET /api/config`): e.g. `claude: false, workersAI: true, stripeApi: false`
- Browser and OS:
- Device width, if it is a layout bug:

### Logs and screenshots

Relevant agent-channel messages, browser console output, or `wrangler tail` output. Screenshots help.
