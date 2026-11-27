# Stalwart Mail Server

[Stalwart](https://stalw.art) is a mail server that sends and receives mail, serves IMAP and JMAP, and filters spam, all from one container. This template publishes SMTP (25), submission (465) and IMAP (993) on public ports with **Keep client addresses** on. Stalwart then sees each sender's real IP, which SPF, blocklists and per-IP rate limits depend on.

## Before you deploy

- **A public IP, and a load balancer that keeps client addresses.** Public ports need a public IP for the organization or an instance default. A single node, k3s ServiceLB, MetalLB in L2 mode or Cilium L2/BGP all keep client addresses. On a multi-node cluster, the ports answer only on the node that runs Stalwart.
- **Port 25 open in both directions.** Many cloud providers and some home ISPs block outbound port 25. Without it, Stalwart can receive mail but cannot deliver it.
- **Two host names.** The admin domain in the form goes through Orchard's ingress. The mail host, such as `mail.example.com`, is the name your MX record points at. It needs a plain A record to the public IP. Cloudflare's proxy does not carry SMTP, so on Cloudflare the record must be **DNS only**.

## After you deploy

1. **Point the standard ports at the public ports.** Orchard picks the public port numbers; the app's **Network** tab lists them. Mail servers only connect to port 25, so forward it there. On a home router, forward `25`, `465` and `993` to the node's address and the matching public port. On a cloud load balancer, add the same listeners.
2. **Protect the admin domain.** Until setup is finished, port 8080 serves a setup wizard that does not limit password guesses. Turn on [app protection](https://docs.orchard.hackclub.com/deploy/protection/) for the admin domain. You can leave it on afterwards.
3. **Sign in to the wizard.** Open the app's logs and find the block that starts with `Stalwart bootstrap mode - temporary administrator account`. Go to `https://<admin domain>/admin` and sign in as `admin` with that password. Use the mail host from the previous section as the server hostname. Keep the storage defaults, which use the data volume. Under **Logging**, choose **Console** so the logs show up in the app's **Logs** tab. The default writes to files that are not on a volume.
4. **Save the new admin password.** The last wizard screen shows it once. Then restart the app from the dashboard to leave bootstrap mode.
5. **Get a certificate for the mail host.** Stalwart's default ACME challenge needs port 443, which belongs to the ingress here. In the WebUI's ACME provider settings, choose the DNS-01 challenge and give it an API token for your DNS provider instead.
6. **Add the DNS records.** In the WebUI, open the domain, copy the MX, SPF, DKIM and DMARC records, and add them at your DNS provider. Set reverse DNS for the public IP to the mail host if your provider allows it.

## Notes

- Stalwart serves port 8080 as plain HTTP, and the ingress adds TLS. `STALWART_PUBLIC_URL` is set to the admin domain, so OAuth and JMAP discovery use that URL.
- POP3 (995), ManageSieve (4190) and STARTTLS submission (587) are not published. To use them, add the port under **Network** and make it public with **Keep client addresses** on.
- Back up the data volume. It holds every mailbox.
