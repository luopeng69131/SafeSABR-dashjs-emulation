FROM python:3.11-alpine

RUN pip install --no-cache-dir selenium==4.35.0

WORKDIR /runner
COPY run_browser.py /runner/run_browser.py

CMD ["python", "/runner/run_browser.py"]
