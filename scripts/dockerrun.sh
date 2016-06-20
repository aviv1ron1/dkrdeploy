#!/bin/bash
set -e

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

FLAGS=""
ECHOONLY=false
if [ -f container.flags ]; then
        FLAGS=$(<container.flags)
fi

while (( $# > 0 ))
do
key="$1"
case $key in
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
                echo "usage: $0 [--name <container name>] [--host <host name>] [--q do not prompt to kill container. kill always] [--x only echo the command, do not run] [--d configure dns] [--flags <list of space separated flags>]"
                exit 1
        ;;
esac
shift
done

echo "using flags: $FLAGS"
INSPECT=$(sudo docker inspect $NAME 2>&1 | grep "Error: No such image or container" | wc -l && :)
if [ $INSPECT -eq 0 ]; then
	sudo docker ps -a | grep $NAME
	if [ -z ${KILLALWAYS+x} ]; then
		echo "container exists. would you like to kill it?"
		read KILL
		if [ $KILL == "y" ]; then
			sudo docker kill $NAME &>/dev/null && :
	        	sudo docker rm $NAME &>/dev/null && :
		else
	        	exit 1
		fi
	else
                sudo docker kill $NAME &>/dev/null && :
                sudo docker rm $NAME &>/dev/null && :
	fi
fi

if [ ! -z "$NAME" ]; then
        NAMEP="--name $NAME"
fi
if [ ! -z "$HOST" ]; then
        HOSTP="-h $HOST"
fi

RUN="sudo docker run $NAMEP $HOSTP $DNS $FLAGS $IMAGE"
echo "$RUN"
if $ECHOONLY; then
        exit 0
fi
CID=$($RUN)

if [ ! -z "$CID" ]; then
        IPADDR=$(sudo docker inspect --format '{{ .NetworkSettings.IPAddress }}' $CID 2>/dev/null && :)
        echo "IP: $IPADDR"
        sudo docker inspect --format '{{ if .NetworkSettings.Ports }}{{println "Exposed ports:"}}{{ range $p, $conf := .NetworkSettings.Ports }}{{printf "%s -> %s\n" $p (index $conf 0).HostPort}}{{end}}{{end}}' $CID 2>/dev/null && :
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