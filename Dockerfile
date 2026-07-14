# Run the monitor pipeline in a container (an alternative to GitHub Actions).
#   docker build -t job-monitor .
#   docker run --rm --env-file .env -v "$PWD/data:/app/data" job-monitor
# Schedule it however you like (host cron, Kubernetes CronJob, etc.).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY monitor/ ./monitor/
COPY data/ ./data/
ENTRYPOINT ["python", "monitor/scraper.py"]
