#!/bin/bash
set -e

if [ ! -f container.image ]; then
        echo "container.image not found. You must have a file container.image with the image name for this script to work"
        exit 1
fi

IMAGE=$(<container.image)

sudo docker build -t $IMAGE .

