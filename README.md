# LANESH

Stateless image shortener built with ElysiaJS, Bun and Redis.

## Run

```bash
docker compose up --build
```

Open `http://localhost:3000`.

## API

```bash
curl -F "file=@image.png" http://localhost:3000/upload
```

Images are limited to 5 MB, validated by file signature and automatically deleted after 7 days. Uploads are rate-limited in Redis. The application stores no files locally.
