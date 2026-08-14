# Pinned by digest so a moved tag cannot swap the base image out from under a
# rebuild. Dependabot bumps this weekly (.github/dependabot.yml), which is what
# keeps the pin from freezing out Alpine and Node security patches.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019

WORKDIR /app

# Owned by root while the process runs as node: the application cannot modify
# its own code even if the read-only filesystem is ever relaxed.
COPY --chown=root:root src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--disable-proto=throw

USER node
EXPOSE 8080 8081

# One image, two roles (web / collector). Their healthchecks differ, so both
# are declared in compose.yaml rather than baked in here.
CMD ["node", "src/server.js"]
