#!/bin/bash

if [ ! -f container.image ]; then
        echo "container.image not found. You must have a file container.image with the image name for this script to work"
        exit 1
fi

IMAGE=$(<container.image)

NAME=""

if [ -f container.name ]; then
        NAME=$(<container.name)
        echo "using name $NAME"
        NAME="$NAME"
fi

CMD=""

if [ -f container.cmd ]; then
        CMD=$(<container.cmd)
        echo "using cmd $CMD"
        CMD="$CMD"
fi

NET=""
if [ -f container.net ]; then
        NET=$(<container.net)
        echo "using net $NET"
        NET="$NET"
        NET_EXISTS=$(docker network ls | grep "$NET" | wc -l)
        if [ $NET_EXISTS -eq 0 ]; then
                echo "network $NET does not exist. creating in default network configuration bridged isolated"
                $(docker network create --driver bridge "$NET")
        fi
fi

FLAGS=""
ECHOONLY=false
RESTART=false
if [ -f container.flags ]; then
        FLAGS=$(<container.flags)
fi

while (( $# > 0 ))
do
key="$1"
case $key in
        --a)
                RESTART=true
        ;;
        --q)
                KILLALWAYS=true
        ;;
        --x)
                ECHOONLY=true
        ;;
        --d)
                DNS=$(ifconfig docker0 | awk '{ if ( $1 == "inet" ) { print substr($2, 6); } }')
                if [ ! -z "$DNS" ]; then
                        DNS="--dns=$DNS"
                else
                        echo "error getting host IP address. cannot set DNS"
                        exit 1
                fi
        ;;
        --name)
                if [[ $# < 2 ]]; then
                        echo "after --name you must include container name"
                        exit 1
                fi
                NAME="$2"
                shift
        ;;
        --host)
                if [[ $# < 2 ]]; then
                        echo "after --host you must include container host name"
                        exit 1
                fi
                HOST="$2"
                shift
        ;;
        --flags)
                shift
                if [[ $# < 1 ]]; then
                        echo "after --flags you must include at least one flag"
                        exit 1
                fi
                while (( $# > 0 )) && [ "$1" != "--name" ]; do
                        FLAGS="$FLAGS $1"
                        shift
                done
        ;;
        *)
                echo "usage: $0 [--name <container name>] [--host <host name>] [--q do not prompt to kill container. kill always] [--x only echo the command, do not run] [--d configure dns] [--a to add restart=unless-stopped] [--flags <list of space separated flags>]"
                exit 1
        ;;
esac
shift
done

if $RESTART; then
        FLAGS="$FLAGS --restart=unless-stopped"
fi

if [ ! -z "$NET" ]; then
        FLAGS="$FLAGS --net=$NET"
fi

eval "echo using flags: $FLAGS"

INSPECT=$(docker inspect $NAME 2>&1 | grep "Error: No such image or container" | wc -l)
if [ $INSPECT -eq 0 ]; then
        docker ps -a | grep $NAME
        if [ -z ${KILLALWAYS+x} ]; then
                echo "container exists. would you like to kill it?"
                read KILL
                if [ $KILL == "y" ]; then
                        docker kill $NAME &>/dev/null
                        docker rm $NAME &>/dev/null
                else
                        if [ ! $ECHOONLY ]; then
                              exit 1
                        fi
                fi
        else
                docker kill $NAME &>/dev/null
                docker rm $NAME &>/dev/null
        fi
fi


if [ ! -z "$NAME" ]; then
        NAMEP="--name $NAME"
fi
if [ ! -z "$HOST" ]; then
        HOSTP="-h $HOST"
fi

RUN="docker run $NAMEP $HOSTP $DNS $FLAGS $IMAGE $CMD"
eval "echo $RUN"
if $ECHOONLY; then
        exit 0
fi
CID=$(eval "$RUN")

if [ ! -z "$CID" ]; then
        IPADDR=$(docker inspect --format '{{ .NetworkSettings.IPAddress }}' $CID 2>/dev/null)
        echo "IP: $IPADDR"
        docker inspect --format '{{ if .NetworkSettings.Ports }}{{println "Exposed ports:"}}{{ range $p, $conf := .NetworkSettings.Ports }}{{printf "%s -> %s\n" $p (index $conf 0).HostPort}}{{end}}{{end}}' $CID 2>/dev/null
        if [ ! -z "$HOST" ] && [ ! -z "$IPADDR" ]; then
                awkscript='
                BEGIN {
                        found=0;
                }
                {
                        if ($2 == host) {
                                print ipaddr "\t" host;
                                found=1;
                        } else {
                                if ($0 == "#docker_ip_here") {
                                        if(found < 1) {
                                                print ipaddr "\t" host;
                                        }
                                        print "#docker_ip_here";
                                } else {
                                        print $0
                                }
                        }
                }
                '
                awk -v host="$HOST" -v ipaddr="$IPADDR" "$awkscript" /etc/hosts > ~/hosts.tmp
                sudo mv ~/hosts.tmp /etc/hosts
                sudo service dnsmasq restart 1>/dev/null
        fi
fi


