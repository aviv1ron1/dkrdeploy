#!/bin/bash

if (( $# < 2)); then
        echo "usage: $0 <image name> <container name> <optional - flags>"
        exit 1
elif (( $# > 3 )); then
        echo "too many arguments. usage: $0 <image name> <container name> <optional - flags>"
        exit 1
else
        echo "$1" > container.image
        echo "$2" > container.name
        if (( $# > 2 )); then
                echo "$3" > container.flags
        fi
fi
