# Nephthys Plus

Nephthys, but built for the community. It runs support channels like #help in a Slack workspace: tickets get tagged (by AI or by hand), assigned to whoever replies, and resolved with a button or a macro.

## Before you deploy

Create the Slack app first, as a workspace admin (otherwise it can't fully delete threads):

1. Go to https://api.slack.com/apps and pick **Create New App > From a manifest**.
2. Paste `manifest.yml` from the [nephthys-plus repo](https://github.com/hackclub/nephthys-plus) and swap the `https://nephthys.hackclub.com/` URLs for the domain you'll use below.
3. Install the app and copy the bot token, user token and signing secret.
4. Invite the bot to the behind-the-scenes and help channels, and to the heartbeat and tickets channels if you set them. If you use a tickets channel, add yourself to it.

## After you deploy

A message shows up in the heartbeat channel, and the bot starts answering in the help channel. If it doesn't, check the logs and make sure the request URLs in the Slack app match your domain.

The tickets channel is optional. Without one, no ticket messages are posted and helpers work from the question threads.

Set Program to a name that isn't a built-in transcript, so your channel IDs and settings are used.

Everything past the Slack basics is optional:

- **AI key and base URL** for ticket titles and category tags. Pick a provider that doesn't train on your prompts.
- **Slack app token** for socket mode, so Slack doesn't need a public URL.
- **Helper OAuth client ID, client secret and token encryption key** let helpers connect their Slack accounts so macros can delete their own trigger messages. Set all three and add `https://your-domain/slack/oauth/callback` to your Slack app's redirect URLs. Generate the Fernet key with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
- **HCA client ID and secret** for the Lobby and API keys. Create an OAuth app on Hack Club Auth with the `slack_id` scope and set the redirect URI to your domain + `/oauth/callback`. Set both or neither. The session secret is generated for you.
- **Feedback, daily summary, stale ticket auto-close, log level** and a few other switches. See the repo's `docs/configuration.md`.
