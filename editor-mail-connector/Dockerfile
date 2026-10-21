FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
ENV PYTHONUNBUFFERED=1 FASTMCP_HOME=/data FASTMCP_SHOW_SERVER_BANNER=false
CMD ["python", "server.py"]
