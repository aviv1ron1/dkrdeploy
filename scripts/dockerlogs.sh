#!/bin/bash

if [ "$1" = "-f" ]; then
        F="-f"
        shift
fi

if [ $# -eq 0 ]; then
        if [ -f container.name ]; then
                NAME=$(<container.name)
        else
                echo "must either state container name as argument or have container.name file with the container name"
                exit 1
        fi
else
        NAME="$1"
fi

sudo docker logs $F $NAME

