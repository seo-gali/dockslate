FROM busybox:1.37.0
WORKDIR /www
COPY index.html /www/index.html
RUN mkdir -p /data && echo "DockSlate volume check OK" > /data/check.txt
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
