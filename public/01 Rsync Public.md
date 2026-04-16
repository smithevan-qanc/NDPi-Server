# Server Device
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.log' \
    --exclude '.DS_Store' --exclude 'rsync-deploy.sh' \
    "/Users/evansmith/NDI/NDPi Monitor (Server) v01172026/public/" "ndpi-server@192.168.1.11:/home/ndpi-server/ndpi-monitor/public/"

# Client Device
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.log' \
    --exclude '.DS_Store' --exclude 'rsync-deploy.sh' \
    "/Users/evansmith/NDI/NDPi Monitor (Server) v01172026/Assets/" "ndpi-client@192.168.1.186:/home/ndpi-client/ndpi-monitor/Assets/"