FROM python:3.9-slim

# working directory
WORKDIR /app

# Copy requirements first to leverage Docker cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Set environment variables
ENV FLASK_APP=server.py
ENV FLASK_ENV=development

# python server port
EXPOSE 8000

# run server
CMD ["python", "server.py"]
