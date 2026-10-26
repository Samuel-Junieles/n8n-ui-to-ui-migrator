# Imagen oficial de Playwright con Chromium, Firefox y WebKit ya instalados.
# La versión de la imagen debe coincidir con la de la dependencia «playwright» de package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY servidor.mjs ./

# Usuario sin privilegios que trae la imagen.
USER pwuser
CMD ["node", "servidor.mjs"]
