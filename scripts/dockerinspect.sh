#!/bin/bash



if (( $# > 0 )); then
        NAME="$1"
elif [ -f container.name ]; then
        NAME=$(<container.name)
else
        echo "must either state container name as argument or have container.name file with the container name"
        exit 1
fi

sudo docker inspect "$NAME"

