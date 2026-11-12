# Security

HeyBotOS starts agents that edit files and run commands on your Mac without asking first. We take problems in
the parts that keep that safe seriously.

## Reporting a problem

Please do not open a public issue. Use GitHub's private reporting instead: on the repository page, open the
**Security** tab and choose **Report a vulnerability**. Say what you found, how to reproduce it, and what you
think it allows. You will get an answer within a week.

## What counts

- Getting past the gate: a worker reaching a server, deploying, publishing or changing something through a
  connector without the owner's yes.
- Reaching the service from outside this Mac, from another site in the browser, or without a session.
- A worker, a connector or anything it reads getting hold of connector keys, sign-in tokens or the service's
  secret.
- Anything that makes a CLI run on metered billing instead of the subscription login.
- An uploaded file or a piece of agent text running as code in the dashboard.

## What the gate is, and is not

The gate is a seatbelt against mistakes. It checks what a worker is about to do and asks you first for the
three kinds of action listed in the README. It is not a sandbox: a worker runs as you, in your project
folder, with your files. Only give HeyBotOS work in folders you would let a capable colleague work in.

## Supported versions

Only the latest release gets fixes.
