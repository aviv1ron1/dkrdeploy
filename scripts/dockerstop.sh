#!/bin/bash

if (( $# > 0 )); then
        NAME="$1"
elif [ -f container.name ]; then
        NAME=$(<container.name)
else
        echo "must either state container name as argument or have container.name file with the container name"
        exit 1
fi
#get the ip address before  killing:
IPADDR=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' $NAME 2>/dev/null)

#kill and remove:
sudo docker kill $NAME 2>/dev/null
sudo docker rm $NAME 2>/dev/null

# remove the listing from /etc/hosts if it exists:
if [ ! -z "$IPADDR" ]; then
        awkscript='
                {
                        if ($1 != ipaddr) {
                                print $0
                        }
                }
                '
                awk -v ipaddr="$IPADDR" "$awkscript" /etc/hosts > ~/hosts.tmp
                if [ $? -eq 0 ]; then
                        sudo mv ~/hosts.tmp /etc/hosts
                fi
fi

